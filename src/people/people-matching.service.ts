import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

/**
 * A single identity signal observed about a person from one
 * platform pull. `source` + `externalId` is the platform's id;
 * `connectionId` records which connection saw it (null for global
 * ids like email).
 */
export interface ObservedIdentifier {
  source: string
  externalId: string
  connectionId?: string | null
}

/**
 * One "this is a person we saw" payload handed to the matcher.
 * `identifiers` is everything we observed about them in this pull
 * (e.g. a Stripe customer gives `[{stripe, cus_x}, {email, a@b.c}]`).
 * `email` / `displayName` are optional human attributes used to
 * enrich the `people` row.
 */
export interface ObservedPerson {
  identifiers: ObservedIdentifier[]
  email?: string | null
  displayName?: string | null
  /** ISO 3166-1 alpha-2 country code (PostHog geoip / Stripe address). */
  country?: string | null
  /** First-touch traffic source (referring domain / utm), '$direct'
   *  already normalised to 'direct'. NULL when the platform has none. */
  initialSource?: string | null
  /** The platform's timestamp for this person (ISO). Sort key + the
   *  displayed "Last seen". See the migration note on its semantics. */
  lastSeenAt?: string | null
}

/**
 * Matching / bridging engine — the platform-agnostic heart of
 * Phase 2. Adapters (Stripe / PostHog / GA) pull their people and
 * call `upsertPerson` for each; this service decides whether that
 * maps to an existing person, a new person, or a MERGE of two
 * previously-separate people.
 *
 * Matching rule (the fork the user delegated — "however you want"):
 *   EMAIL IS AUTHORITATIVE, auto-merge. Two records that share any
 *   identifier — most powerfully email — are the same person, and
 *   we collapse them automatically. No review queue in v1; the SDK
 *   later tightens cross-device accuracy where email alone is too
 *   coarse. The conservative cost (a rare false merge between two
 *   people who genuinely share an email, e.g. a shared family
 *   address) is acceptable and rare; the alternative (a review
 *   backlog nobody triages) is worse for a solo-founder tool.
 *
 * Idempotent + re-runnable: calling it again with the same data is
 * a no-op (identifiers are UNIQUE per project, attach is upsert).
 * Running it after MORE connections exist merges what was separate
 * — which is the intended "gets cleaner as you connect more"
 * behaviour. Counts can drop as duplicates collapse; that's
 * correct, not a bug.
 *
 * All writes go through the service-role client and carry `userId`
 * so the rows satisfy the owner-only RLS policies.
 */
@Injectable()
export class PeopleMatchingService {
  private readonly logger = new Logger(PeopleMatchingService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Resolve an observed person to a canonical `people` row,
   * attaching all their identifiers. Returns the canonical
   * person id.
   *
   * Algorithm:
   *   1. Normalise the identifier set (lower-case emails, fold an
   *      explicit `email` attribute into the identifier list as a
   *      source='email' row).
   *   2. Look up which existing people already own any of these
   *      identifiers.
   *   3. Zero matches  → create a new person.
   *      One match     → use it.
   *      Many matches   → MERGE them into one, then use the survivor.
   *   4. Attach every identifier to the resolved person (upsert).
   *   5. Enrich the person row (email / name) if we learned more.
   */
  async upsertPerson(
    userId: string,
    projectId: string,
    observed: ObservedPerson,
  ): Promise<string> {
    const identifiers = this.normaliseIdentifiers(observed)
    if (identifiers.length === 0) {
      // Nothing to match on — we never create an identifier-less
      // ghost person. Caller gave us no usable signal.
      throw new Error('upsertPerson called with no identifiers')
    }

    const matchedPersonIds = await this.findMatchingPersonIds(
      userId,
      projectId,
      identifiers,
    )

    let personId: string
    if (matchedPersonIds.length === 0) {
      personId = await this.createPerson(userId, projectId, observed)
    } else if (matchedPersonIds.length === 1) {
      personId = matchedPersonIds[0]
    } else {
      // Multiple existing people share identifiers with this
      // observation → they're the same human seen separately before
      // a bridge existed. Collapse them.
      personId = await this.mergePeople(userId, matchedPersonIds)
    }

    await this.attachIdentifiers(userId, projectId, personId, identifiers)
    await this.enrichPerson(userId, personId, observed)

    return personId
  }

  // ── steps ─────────────────────────────────────────────────────

  /**
   * Fold the optional `email` attribute into the identifier list,
   * lower-case all emails, and de-dupe. Email is both an attribute
   * (for display) AND an identifier (for matching) — treating it as
   * an identifier is what makes email the cross-platform bridge.
   */
  private normaliseIdentifiers(observed: ObservedPerson): ObservedIdentifier[] {
    const out = new Map<string, ObservedIdentifier>()
    const push = (id: ObservedIdentifier) => {
      const externalId =
        id.source === 'email' ? id.externalId.trim().toLowerCase() : id.externalId.trim()
      if (!externalId) return
      out.set(`${id.source}:${externalId}`, { ...id, externalId })
    }
    for (const id of observed.identifiers) push(id)
    if (observed.email) {
      push({ source: 'email', externalId: observed.email, connectionId: null })
    }
    return Array.from(out.values())
  }

  /**
   * Distinct existing person ids that own ANY of the given
   * identifiers in this project. The `(project_id, source,
   * external_id)` UNIQUE index serves this probe directly.
   */
  private async findMatchingPersonIds(
    userId: string,
    projectId: string,
    identifiers: ObservedIdentifier[],
  ): Promise<string[]> {
    // Build an OR of (source AND external_id) pairs. Supabase's
    // `.or()` with `and(...)` groups expresses this in one query.
    const orClause = identifiers
      .map(
        id =>
          `and(source.eq.${this.esc(id.source)},external_id.eq.${this.esc(id.externalId)})`,
      )
      .join(',')

    const { data, error } = await this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('person_id')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .or(orClause)

    if (error) throw new Error(error.message)
    const ids = new Set<string>()
    for (const row of data ?? []) ids.add((row as { person_id: string }).person_id)
    return Array.from(ids)
  }

  private async createPerson(
    userId: string,
    projectId: string,
    observed: ObservedPerson,
  ): Promise<string> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('people')
      .insert({
        project_id: projectId,
        user_id: userId,
        display_name: observed.displayName ?? null,
        primary_email: observed.email ? observed.email.trim().toLowerCase() : null,
        country: observed.country ?? null,
        initial_source: observed.initialSource ?? null,
        last_seen_at: observed.lastSeenAt ?? null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    return (data as { id: string }).id
  }

  /**
   * Collapse N people into the oldest one (the survivor). Re-points
   * their identifiers + events to the survivor, then deletes the
   * losers. Ordered by `created_at` so the survivor is the
   * longest-lived record (most stable id to keep).
   *
   * Identifier re-point uses upsert-by-unique: a loser's identifier
   * might already exist on the survivor (rare), so we move what we
   * can and the UNIQUE constraint absorbs the rest.
   */
  private async mergePeople(userId: string, personIds: string[]): Promise<string> {
    const client = this.supabaseService.getClient()

    // Resolve survivor = oldest.
    const { data: rows, error } = await client
      .from('people')
      .select('id, created_at')
      .eq('user_id', userId)
      .in('id', personIds)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    if (!rows || rows.length === 0) throw new Error('mergePeople: no people found')

    const survivor = (rows[0] as { id: string }).id
    const losers = personIds.filter(id => id !== survivor)
    if (losers.length === 0) return survivor

    this.logger.log(
      `Merging people [${losers.join(', ')}] → ${survivor} (user=${userId})`,
    )

    // Re-point events first (no UNIQUE collision risk — events keep
    // their own idempotency key). Then identifiers, tolerating the
    // rare pre-existing collision by deleting the loser's dup.
    const { error: evErr } = await client
      .from('people_events')
      .update({ person_id: survivor })
      .eq('user_id', userId)
      .in('person_id', losers)
    if (evErr) throw new Error(evErr.message)

    // Move identifiers. On UNIQUE conflict (survivor already has it)
    // the update would fail the whole statement, so we move per-row
    // and swallow conflicts by deleting the loser copy.
    const { data: loserIds, error: liErr } = await client
      .from('people_identifiers')
      .select('id, source, external_id')
      .eq('user_id', userId)
      .in('person_id', losers)
    if (liErr) throw new Error(liErr.message)

    for (const row of loserIds ?? []) {
      const r = row as { id: string; source: string; external_id: string }
      const { error: upErr } = await client
        .from('people_identifiers')
        .update({ person_id: survivor })
        .eq('id', r.id)
      if (upErr) {
        // Survivor already owns this identifier → drop the duplicate.
        await client.from('people_identifiers').delete().eq('id', r.id)
      }
    }

    // Delete the now-empty loser person rows.
    const { error: delErr } = await client
      .from('people')
      .delete()
      .eq('user_id', userId)
      .in('id', losers)
    if (delErr) throw new Error(delErr.message)

    return survivor
  }

  /**
   * Attach every observed identifier to the resolved person.
   * Upsert on the `(project_id, source, external_id)` unique key:
   * a brand-new id inserts; an existing one bumps `last_seen_at`
   * and re-points to this person (covers the case where matching
   * found the person via a DIFFERENT id than the one being
   * attached). `ignoreDuplicates: false` => it performs the update.
   */
  private async attachIdentifiers(
    userId: string,
    projectId: string,
    personId: string,
    identifiers: ObservedIdentifier[],
  ): Promise<void> {
    const nowIso = new Date().toISOString()
    const rows = identifiers.map(id => ({
      person_id: personId,
      project_id: projectId,
      user_id: userId,
      connection_id: id.connectionId ?? null,
      source: id.source,
      external_id: id.externalId,
      last_seen_at: nowIso,
    }))

    const { error } = await this.supabaseService
      .getClient()
      .from('people_identifiers')
      .upsert(rows, {
        onConflict: 'project_id,source,external_id',
        ignoreDuplicates: false,
      })
    if (error) throw new Error(error.message)
  }

  /**
   * Backfill the person's display fields from this observation:
   *   - name / email / country / initial_source → FILL nulls only
   *     (first non-null wins; later pulls never clobber).
   *   - last_seen_at → keep the LATEST (so re-syncs and multiple
   *     platforms advance it, never rewind it).
   * No-op when the observation adds nothing.
   */
  private async enrichPerson(
    userId: string,
    personId: string,
    observed: ObservedPerson,
  ): Promise<void> {
    const email = observed.email ? observed.email.trim().toLowerCase() : null
    const name = observed.displayName ?? null
    const country = observed.country ?? null
    const initialSource = observed.initialSource ?? null
    const lastSeenAt = observed.lastSeenAt ?? null
    if (!email && !name && !country && !initialSource && !lastSeenAt) return

    const { data: current, error } = await this.supabaseService
      .getClient()
      .from('people')
      .select('primary_email, display_name, country, initial_source, last_seen_at')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!current) return

    const cur = current as {
      primary_email: string | null
      display_name: string | null
      country: string | null
      initial_source: string | null
      last_seen_at: string | null
    }
    const patch: Record<string, string> = {}
    if (email && !cur.primary_email) patch.primary_email = email
    if (name && !cur.display_name) patch.display_name = name
    if (country && !cur.country) patch.country = country
    if (initialSource && !cur.initial_source) patch.initial_source = initialSource
    // Advance last_seen_at to the most recent observed timestamp.
    // Compare by parsed epoch, NOT string: the observed value is
    // normalised ISO ("…Z") while the stored timestamptz comes back
    // as "…+00:00", so a lexicographic compare would be unreliable.
    if (lastSeenAt) {
      const observedMs = new Date(lastSeenAt).getTime()
      const currentMs = cur.last_seen_at ? new Date(cur.last_seen_at).getTime() : NaN
      if (!Number.isNaN(observedMs) && (Number.isNaN(currentMs) || observedMs > currentMs)) {
        patch.last_seen_at = lastSeenAt
      }
    }
    if (Object.keys(patch).length === 0) return

    const { error: upErr } = await this.supabaseService
      .getClient()
      .from('people')
      .update(patch)
      .eq('user_id', userId)
      .eq('id', personId)
    if (upErr) throw new Error(upErr.message)
  }

  /**
   * Escape a value for use inside a PostgREST `.or()` filter. Commas
   * and parens are the structural characters; identifiers from
   * platforms shouldn't contain them, but a stray one would break
   * the filter syntax, so we defensively strip them. (Emails / UUIDs
   * / cus_… never legitimately contain these.)
   */
  private esc(value: string): string {
    return value.replace(/[(),]/g, '')
  }
}
