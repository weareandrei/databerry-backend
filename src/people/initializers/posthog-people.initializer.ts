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
 * Per person we also ingest a small event timeline — a "first seen"
 * marker (from `person.created_at`) plus their most recent PostHog
 * events (by distinct_id) — via `PeopleEventsService`. That ingestion
 * is best-effort: a flaky/absent events API degrades to just the
 * marker and never fails the identity sync.
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
    // Per-run definition cache (eventKey → definition id) so we upsert
    // each event_definition at most once, not once per occurrence.
    const defCache = new Map<string, string>()

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
          await this.ingestPerson(
            userId,
            projectId,
            connectionId,
            person,
            creds,
            defCache,
            lastSeenByDid,
          )
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

    await this.markSynced(connectionId, projectId, userId)
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
    creds: PosthogCreds,
    defCache: Map<string, string>,
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

    // Throws on failure — the caller's loop counts successes, logs
    // per-row failures, and escalates an all-failed batch.
    const personId = await this.matching.upsertPerson(userId, projectId, {
      identifiers,
      email,
      displayName: name,
      country,
      initialSource,
      lastSeenAt,
    })

    // Event timeline — BEST EFFORT. The events API may be flaky, rate-
    // limited, or shaped differently across PostHog versions; none of
    // that should fail the identity sync that already succeeded.
    try {
      await this.ingestPersonEvents(
        userId,
        projectId,
        connectionId,
        personId,
        distinctIds,
        creds,
        defCache,
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`PostHog events skipped for ${person.id}: ${detail}`)
    }
  }

  /**
   * Persist one person's REAL PostHog event timeline — their most
   * recent events across ALL their distinct_ids (a person usually has
   * several; querying only the first misses most of their activity,
   * which is why active users were showing an empty timeline). Real
   * events only — no synthetic "first seen" marker (it was confusing
   * and, once real events flow, redundant). Each PostHog event id is
   * the idempotency key, so re-syncs refresh rather than duplicate.
   */
  private async ingestPersonEvents(
    userId: string,
    projectId: string,
    connectionId: string,
    personId: string,
    distinctIds: string[],
    creds: PosthogCreds,
    defCache: Map<string, string>,
  ): Promise<void> {
    const events = await this.fetchPersonEvents(creds, distinctIds)
    if (events.length === 0) return

    await this.events.recordEvents(
      userId,
      projectId,
      connectionId,
      'posthog',
      personId,
      events,
      defCache,
    )
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
   * Most recent events across ALL of a person's distinct_ids (cap 200,
   * newest first). Uses the HogQL query API — the same proven path the
   * Users view uses — which is far more reliable than the legacy
   * `/events` endpoint (that one silently returned nothing for many
   * distinct_ids, leaving active users with an empty timeline). Selects
   * only the few properties we actually render, as columns.
   */
  private async fetchPersonEvents(
    creds: PosthogCreds,
    distinctIds: string[],
  ): Promise<ObservedEvent[]> {
    if (distinctIds.length === 0) return []
    const inList = distinctIds.map(d => `'${escHogql(d)}'`).join(', ')
    const hogql =
      'SELECT toString(uuid), event, timestamp, properties ' +
      `FROM events WHERE distinct_id IN (${inList}) ` +
      'ORDER BY timestamp DESC LIMIT 200'

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
    const out: ObservedEvent[] = []
    for (const row of json.results ?? []) {
      const id = asString(row?.[0])
      const event = asString(row?.[1])
      const occurredAt = toIsoUtc(asString(row?.[2]))
      if (!id || !event || !occurredAt) continue
      out.push({
        eventKey: event,
        displayName: prettifyEventName(event),
        occurredAt,
        sourceEventId: id,
        properties: buildPosthogProps(event, parsePropertyBag(row?.[3])),
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
   * Light sync bookkeeping — same as the Stripe initializer. Records
   * that identity was pulled; does NOT touch `last_event_at` (that's
   * the Phase 3 event watchdog's column).
   */
  private async markSynced(
    connectionId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .upsert(
        {
          connection_id: connectionId,
          project_id: projectId,
          user_id: userId,
          last_synced_at: new Date().toISOString(),
          last_status: 'people_initialized',
          last_error: null,
        },
        { onConflict: 'connection_id' },
      )
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
 * from its full property bag. Friendly keys the frontend reads directly:
 *   - `path`        — the page visited (pageview / pageleave / click)
 *   - `elementText` — the text of the clicked element (autocapture)
 *   - `method`      — the auth method, for login-type events ("Google")
 */
function buildPosthogProps(
  event: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const str = (k: string): string | undefined => {
    const v = raw[k]
    return typeof v === 'string' && v.trim() ? v : undefined
  }

  // Page — the path of whatever URL the event carries (every $pageview
  // has `$current_url`, so this is the "what page" answer).
  const path = str('$pathname') ?? pathFromUrl(str('$current_url'))
  if (path) out.path = path

  // Click — autocapture stores the clicked element's text in `$el_text`.
  const elText = str('$el_text')
  if (elText) out.elementText = elText.replace(/\s+/g, ' ').trim().slice(0, 80)

  // Login method — only for login / sign-in events, from the common
  // property names apps use. App-specific, so best-effort.
  const ev = event.toLowerCase()
  if ((ev.includes('log') && ev.includes('in')) || ev.includes('sign')) {
    const method =
      str('provider') ?? str('login_method') ?? str('$oauth_provider') ?? str('method')
    if (method) out.method = method
  }

  return out
}

/**
 * Normalise the `properties` cell the HogQL query returns — it comes
 * back as a raw JSON string on some PostHog versions and an already-
 * parsed object on others. Always returns a plain object; never throws.
 */
function parsePropertyBag(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Coerce a HogQL result cell to a non-empty trimmed string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Escape a value for a single-quoted HogQL/ClickHouse string literal. */
function escHogql(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
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

