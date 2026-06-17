import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { PeopleMatchingService } from '../people-matching.service'
import { PeopleEventsService, type ObservedEvent } from '../people-events.service'
import { getPosthogCredentials } from '../../posthog/connection/credentials'

/** Resolved PostHog credentials (host + project + API key). */
type PosthogCreds = { host: string; projectId: string; apiKey: string }

/**
 * PostHog → people initializer (Phase 2, second adapter).
 *
 * Pulls every person from a PostHog project and feeds each into the
 * matcher. A PostHog person carries:
 *   - one or more `distinct_ids` → each becomes a `posthog`
 *     identifier (this is what makes phone+PC merge once the SDK or
 *     a login links their distinct_ids), AND
 *   - `properties.email` / `.name` when the app called
 *     `posthog.identify(email)`.
 *
 * The EMAIL is the cross-platform bridge: when a PostHog person and
 * a Stripe customer share an email, the matcher auto-merges them
 * into one person — the whole point of the identity graph. People
 * with no email stay PostHog-only until the SDK supplies a bridge.
 *
 * Events are ingested in ONE bulk pass AFTER the identity loop
 * (`syncEvents`), not per person: a single HogQL query pulls everyone's
 * events since the `last_event_at` watermark, then `PeopleEventsService`
 * batch-inserts them. Incremental + best-effort — the first run grabs a
 * bounded history, every run after only the delta, and a failure leaves
 * identity synced and retries the same window next time.
 *
 * Re-runnable + idempotent, same as the Stripe initializer.
 */
@Injectable()
export class PosthogPeopleInitializer {
  private readonly logger = new Logger(PosthogPeopleInitializer.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly matching: PeopleMatchingService,
    private readonly events: PeopleEventsService,
  ) {}

  /**
   * Initialize people for one PostHog connection into one project.
   * Returns the count of persons processed.
   */
  async initialize(
    connectionId: string,
    projectId: string,
    userId: string,
  ): Promise<{ processed: number }> {
    const creds = await getPosthogCredentials(connectionId, this.supabaseService)
    if (!creds) throw new Error('PostHog credentials not found')

    let processed = 0 // SUCCESSFUL upserts (not attempts)
    let firstError: string | null = null
    // PostHog paginates with a fully-formed `next` URL. Start at the
    // persons endpoint; follow `next` until exhausted or the page cap.
    let url: string | null =
      `${creds.host}/api/projects/${creds.projectId}/persons/?limit=100`
    const MAX_PAGES = 100 // 100 × 100 = 10k persons per run; re-runs continue.

    // TRUE last-activity per distinct_id, in ONE HogQL pass (mirrors the
    // Users view's `max(timestamp)` pattern). This is what fixes "last
    // seen" — a person's `created_at` is FIRST-seen and never advances,
    // so daily users were stuck showing the day they first appeared.
    // Best-effort: if the query fails we fall back to first-seen.
    let lastSeenByDid = new Map<string, string>()
    try {
      lastSeenByDid = await this.fetchLastSeenByDistinctId(creds)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`PostHog last-seen query failed; using first-seen: ${detail}`)
    }

    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`PostHog persons API ${res.status}: ${body.slice(0, 200)}`)
      }

      const json = (await res.json()) as {
        results?: PosthogPerson[]
        next?: string | null
      }
      const persons = json.results ?? []
      if (persons.length === 0) break

      for (const person of persons) {
        try {
          await this.ingestPerson(userId, projectId, connectionId, person, lastSeenByDid)
          processed++
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          if (!firstError) firstError = detail
          this.logger.warn(`Skipped PostHog person ${person.id}: ${detail}`)
        }
      }

      url = json.next ?? null
    }

    // Attempted persons but NONE succeeded → systemic failure (missing
    // `people*` migration, RLS) rather than a few bad rows. Surface it
    // loudly instead of a hollow "success" with zero people.
    if (processed === 0 && firstError) {
      throw new Error(`No PostHog persons could be synced — ${firstError}`)
    }

    // Drop the old synthetic "First seen" markers we used to insert —
    // we now show real events instead, so these are stale noise.
    await this.deleteSyntheticFirstSeen(connectionId, userId)

    // Event timeline — ONE bulk + incremental pass for everyone (vs. the
    // old query-per-person firehose). Best-effort: a failure here leaves
    // identity synced and just retries the same window next time.
    let newWatermark: string | null = null
    try {
      newWatermark = await this.syncEvents(userId, projectId, connectionId, creds)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`PostHog event sync failed for ${connectionId}: ${detail}`)
    }

    await this.markSynced(connectionId, projectId, userId, newWatermark)
    this.logger.log(
      `PostHog people init done  connection=${connectionId} project=${projectId} persons=${processed}`,
    )
    return { processed }
  }

  /**
   * Map one PostHog person → one `upsertPerson` call. Every
   * `distinct_id` becomes a `posthog` identifier; email/name come
   * from person properties when present. Skip persons with no
   * distinct_ids AND no email (nothing to match on).
   */
  private async ingestPerson(
    userId: string,
    projectId: string,
    connectionId: string,
    person: PosthogPerson,
    lastSeenByDid: Map<string, string>,
  ): Promise<void> {
    const distinctIds = (person.distinct_ids ?? []).filter(Boolean)
    const props = person.properties ?? {}
    const email = typeof props.email === 'string' ? props.email : null
    const name = typeof props.name === 'string' ? props.name : null

    if (distinctIds.length === 0 && !email) return

    // Display attributes for the Overview "People" table. PostHog sets
    // `$geoip_*` (when geoip is enabled) and `$initial_*` person
    // properties.
    const country =
      typeof props.$geoip_country_code === 'string' ? props.$geoip_country_code : null
    const initialSource = normalizeReferrer(
      (typeof props.$initial_referring_domain === 'string'
        ? props.$initial_referring_domain
        : null) ??
        (typeof props.$initial_utm_source === 'string' ? props.$initial_utm_source : null),
    )

    // LAST SEEN = the person's most recent event across any of their
    // distinct_ids (from the bulk activity map). `person.created_at` is
    // FIRST-seen, so it's only the fallback when we have no activity
    // signal — never the primary value, or daily users look stale.
    let lastSeenAt: string | null = null
    for (const did of distinctIds) {
      const seen = lastSeenByDid.get(did)
      if (seen && (!lastSeenAt || seen > lastSeenAt)) lastSeenAt = seen
    }
    if (!lastSeenAt && typeof person.created_at === 'string') {
      lastSeenAt = person.created_at
    }

    const identifiers = distinctIds.map(did => ({
      source: 'posthog',
      externalId: did,
      connectionId,
    }))

    // Identity only. Throws on failure — the caller's loop counts
    // successes, logs per-row failures, and escalates an all-failed
    // batch. Events are ingested in one bulk pass after the whole person
    // list is in (see `syncEvents`).
    await this.matching.upsertPerson(userId, projectId, {
      identifiers,
      email,
      displayName: name,
      country,
      initialSource,
      lastSeenAt,
    })
  }

  /**
   * Event timeline ingestion — BULK + INCREMENTAL.
   *
   * One HogQL query pulls EVERY person's events since the watermark
   * (`connection_sync_state.last_event_at`), time-ordered + capped. We
   * map each event to a person via a single pre-loaded identifier map,
   * then hand the whole set to `recordEventsBatch` for one chunked
   * insert. Returns the new watermark (latest event timestamp seen), or
   * the old one when there's nothing new.
   *
   * This replaces the per-person query firehose: identical data, ~3
   * queries instead of one-per-person.
   */
  private async syncEvents(
    userId: string,
    projectId: string,
    connectionId: string,
    creds: PosthogCreds,
  ): Promise<string | null> {
    const watermark = await this.readWatermark(connectionId, userId)
    const personByDid = await this.loadPersonByDistinctId(connectionId, userId)
    if (personByDid.size === 0) return watermark // no people yet → nothing to attach

    const rawEvents = await this.fetchEventsSince(creds, watermark)

    const defCache = new Map<string, string>()
    const batch: (ObservedEvent & { personId: string })[] = []
    let maxIso = watermark
    for (const e of rawEvents) {
      const personId = personByDid.get(e.distinctId)
      if (!personId) continue // event for a distinct_id we haven't bridged → skip
      batch.push({
        eventKey: e.eventKey,
        displayName: e.displayName,
        occurredAt: e.occurredAt,
        sourceEventId: e.sourceEventId,
        properties: e.properties,
        personId,
      })
      // ISO UTC strings compare chronologically — track the newest.
      if (!maxIso || e.occurredAt > maxIso) maxIso = e.occurredAt
    }

    await this.events.recordEventsBatch(userId, projectId, connectionId, 'posthog', batch, defCache)
    return maxIso
  }

  /** The watermark — timestamp of the latest event we've ingested for
   *  this connection. Null on the first sync. */
  private async readWatermark(connectionId: string, userId: string): Promise<string | null> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .select('last_event_at')
      .eq('connection_id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data as { last_event_at?: string | null } | null)?.last_event_at ?? null
  }

  /**
   * Map every `posthog` distinct_id we've bridged for this connection to
   * its person id, so the bulk events attach without a lookup per event.
   * Pages through identifiers (Supabase caps a select at 1000 rows).
   */
  private async loadPersonByDistinctId(
    connectionId: string,
    userId: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('people_identifiers')
        .select('external_id, person_id')
        .eq('user_id', userId)
        .eq('connection_id', connectionId)
        .eq('source', 'posthog')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      for (const r of rows) {
        const rr = r as { external_id: string; person_id: string }
        if (rr.external_id && rr.person_id) map.set(rr.external_id, rr.person_id)
      }
      if (rows.length < PAGE) break
    }
    return map
  }

  /**
   * TRUE last-activity time per distinct_id, in ONE HogQL pass (mirrors
   * the Users view's `max(timestamp)` query). Bounded to the last 365
   * days so the aggregation stays cheap on large projects — a person
   * with no activity in a year just falls back to first-seen.
   *
   * Returns Map<distinct_id, ISO-8601 UTC>, timestamps normalised to a
   * single canonical form so downstream comparisons are reliable.
   */
  private async fetchLastSeenByDistinctId(creds: PosthogCreds): Promise<Map<string, string>> {
    const hogql =
      'SELECT distinct_id, max(timestamp) AS last_seen FROM events ' +
      'WHERE timestamp > now() - INTERVAL 365 DAY GROUP BY distinct_id'
    const res = await fetch(`${creds.host}/api/projects/${creds.projectId}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`PostHog last-seen query ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { results?: [string, string][] }
    const map = new Map<string, string>()
    for (const row of json.results ?? []) {
      const iso = toIsoUtc(row?.[1])
      if (row?.[0] && iso) map.set(row[0], iso)
    }
    return map
  }

  /**
   * ALL events since the watermark, in ONE HogQL query (the same proven
   * query API the Users view uses). Time-ASCending + capped, so an
   * oversized first run processes the oldest slice, advances the
   * watermark, and the next sync continues — no events are ever skipped.
   * Selects only the columns we render, to keep the response lean.
   */
  private async fetchEventsSince(
    creds: PosthogCreds,
    watermark: string | null,
  ): Promise<(ObservedEvent & { distinctId: string })[]> {
    // Watermark → epoch seconds (timezone-proof); first run → last 90 days.
    const since = watermark
      ? `timestamp >= fromUnixTimestamp(${Math.floor(new Date(watermark).getTime() / 1000)})`
      : 'timestamp >= now() - INTERVAL 90 DAY'
    const hogql =
      'SELECT distinct_id, toString(uuid), event, timestamp, ' +
      'properties.$pathname, properties.$current_url, properties.$el_text, ' +
      'coalesce(properties.provider, properties.login_method, properties.method) ' +
      `FROM events WHERE ${since} ` +
      'ORDER BY timestamp ASC LIMIT 25000'

    const res = await fetch(`${creds.host}/api/projects/${creds.projectId}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`PostHog events query ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = (await res.json()) as { results?: unknown[][] }
    const out: (ObservedEvent & { distinctId: string })[] = []
    for (const row of json.results ?? []) {
      const distinctId = asString(row?.[0])
      const id = asString(row?.[1])
      const event = asString(row?.[2])
      const occurredAt = toIsoUtc(asString(row?.[3]))
      if (!distinctId || !id || !event || !occurredAt) continue
      out.push({
        distinctId,
        eventKey: event,
        displayName: prettifyEventName(event),
        occurredAt,
        sourceEventId: id,
        properties: buildPosthogProps(event, {
          pathname: asString(row?.[4]),
          currentUrl: asString(row?.[5]),
          elementText: asString(row?.[6]),
          loginMethod: asString(row?.[7]),
        }),
      })
    }
    return out
  }

  /**
   * Delete the synthetic "first_seen" events we used to insert (their
   * `source_event_id` ends in `:first_seen`). Cheap + idempotent; runs
   * each sync so the stale markers vanish from already-synced people on
   * the next refresh.
   */
  private async deleteSyntheticFirstSeen(
    connectionId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabaseService
      .getClient()
      .from('people_events')
      .delete()
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .like('source_event_id', '%:first_seen')
    if (error) {
      this.logger.warn(`first_seen cleanup failed for ${connectionId}: ${error.message}`)
    }
  }

  /**
   * Sync bookkeeping — records when identity was pulled AND advances the
   * `last_event_at` watermark to the newest event we ingested this run.
   * The watermark is what makes the next sync incremental.
   */
  private async markSynced(
    connectionId: string,
    projectId: string,
    userId: string,
    lastEventAt: string | null,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      connection_id: connectionId,
      project_id: projectId,
      user_id: userId,
      last_synced_at: new Date().toISOString(),
      last_status: 'people_initialized',
      last_error: null,
    }
    // Only advance the watermark when we actually ingested newer events —
    // omitting the column leaves the existing value untouched.
    if (lastEventAt) payload.last_event_at = lastEventAt

    const { error } = await this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .upsert(payload, { onConflict: 'connection_id' })
    if (error) {
      this.logger.warn(`Could not record sync state for ${connectionId}: ${error.message}`)
    }
  }
}

/**
 * Normalise a PostHog referrer/utm value into a clean source label:
 * `$direct` / empty → `direct`; otherwise strip a `www.` prefix and
 * lower-case (so `www.Google.com` → `google.com`). NULL passes through.
 */
function normalizeReferrer(raw: string | null): string | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  if (!v || v === '$direct' || v === '(direct)' || v === '(none)') return 'direct'
  return v.replace(/^www\./, '')
}

/**
 * Normalise a HogQL/ClickHouse timestamp ("2026-06-15 10:30:00",
 * "2026-06-15T10:30:00", optionally zoned) to canonical ISO-8601 UTC.
 * Bare (zoneless) values are treated as UTC — how PostHog stores event
 * timestamps. Returns null on unparseable input.
 */
function toIsoUtc(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = String(raw).trim().replace(' ', 'T')
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Turn a raw PostHog event name into a readable timeline label:
 * known `$`-events get curated names; otherwise strip a leading `$`,
 * de-snake/kebab, and sentence-case (`signed_up` → `Signed up`).
 */
function prettifyEventName(raw: string): string {
  const known: Record<string, string> = {
    $pageview: 'Page view',
    $pageleave: 'Page leave',
    $autocapture: 'Click / interaction',
    $identify: 'Identified',
    $set: 'Profile updated',
    $screen: 'Screen view',
    // "Web vitals" is jargon — call it what it measures.
    $web_vitals: 'Page performance',
  }
  if (known[raw]) return known[raw]
  const cleaned = raw.replace(/^\$/, '').replace(/[_-]+/g, ' ').trim()
  if (!cleaned) return raw
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

/**
 * Build the curated `properties` we store + render for a PostHog event,
 * from the specific columns the bulk query selected. Friendly keys the
 * frontend reads directly:
 *   - `path`        — the page visited (pageview / pageleave / click)
 *   - `elementText` — the text of the clicked element (autocapture)
 *   - `method`      — the auth method, for login-type events ("Google")
 */
function buildPosthogProps(
  event: string,
  cols: {
    pathname?: string
    currentUrl?: string
    elementText?: string
    loginMethod?: string
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // Page — the path of whatever URL the event carries (every $pageview
  // has `$current_url`, so this is the "what page" answer).
  const path = cols.pathname ?? pathFromUrl(cols.currentUrl)
  if (path) out.path = path

  // Click — autocapture stores the clicked element's text in `$el_text`.
  if (cols.elementText) {
    out.elementText = cols.elementText.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  // Login method — only for login / sign-in events; the coalesced
  // candidate is app-specific, so this is best-effort.
  const ev = event.toLowerCase()
  if (((ev.includes('log') && ev.includes('in')) || ev.includes('sign')) && cols.loginMethod) {
    out.method = cols.loginMethod
  }

  return out
}

/** Coerce a HogQL result cell to a non-empty trimmed string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Pathname of a URL (e.g. `/pricing`), or undefined if it won't parse. */
function pathFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname || '/'
  } catch {
    return undefined
  }
}

/** Minimal shape of the PostHog person fields we consume. */
interface PosthogPerson {
  id: string | number
  distinct_ids?: string[]
  properties?: Record<string, unknown>
  /** PostHog's first-seen timestamp for the person (ISO). */
  created_at?: string
}

