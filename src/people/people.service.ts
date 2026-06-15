import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

/**
 * Read-side service for the cross-platform people graph (Phase 1).
 *
 * Pure reads for now — population (matching/bridging) and event
 * ingestion land in later phases. Every query is scoped by
 * `user_id` so the service-role client (which bypasses RLS) still
 * can't leak one customer's people to another. Callers pass the
 * authenticated `userId` from `req.authUser.id`.
 *
 * snake_case → camelCase mapping happens at this boundary so the
 * controller / frontend never see raw column names.
 */
@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * List people in a project. Newest-first. `limit` caps the page
   * (default 100) — the funnel/people UI paginates; we never want
   * to ship 50k rows in one response. `search` does a cheap email /
   * name prefix match when present.
   */
  async listPeople(
    userId: string,
    projectId: string,
    opts: { limit?: number; search?: string } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    let query = this.supabaseService
      .getClient()
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (opts.search && opts.search.trim()) {
      const term = `%${opts.search.trim()}%`
      // `or` across the two human-readable columns. ilike = case-
      // insensitive. The partial email index doesn't serve ilike,
      // but at the page sizes here a seq-scan within one project is
      // fine; we revisit if a customer's people count makes it slow.
      query = query.or(`primary_email.ilike.${term},display_name.ilike.${term}`)
    }

    const { data, error } = await query
    if (error) throw new Error(error.message)
    return (data ?? []).map(this.toPersonCamel)
  }

  /**
   * One person + their full identifier list. 404 if the person
   * doesn't exist OR belongs to another user (we don't distinguish —
   * leaking "this id exists but isn't yours" is itself a small
   * information leak).
   */
  async getPerson(userId: string, personId: string) {
    const { data: person, error } = await this.supabaseService
      .getClient()
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!person) throw new NotFoundException('Person not found')

    const { data: identifiers, error: idErr } = await this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('*')
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('created_at', { ascending: true })

    if (idErr) throw new Error(idErr.message)

    return {
      ...this.toPersonCamel(person),
      identifiers: (identifiers ?? []).map(this.toIdentifierCamel),
    }
  }

  /**
   * A person's event timeline, newest-first. Joins the event
   * definition so each row carries its human label + source without
   * a second round-trip. `limit` defaults to 100.
   */
  async getPersonEvents(
    userId: string,
    personId: string,
    opts: { limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

    // Verify ownership first — a person from another user must 404
    // before we hand back any events.
    const { data: person, error: pErr } = await this.supabaseService
      .getClient()
      .from('people')
      .select('id')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()
    if (pErr) throw new Error(pErr.message)
    if (!person) throw new NotFoundException('Person not found')

    const { data, error } = await this.supabaseService
      .getClient()
      .from('people_events')
      .select(
        'id, occurred_at, properties, source_event_id, connection_id, event_definitions(event_key, display_name, source)',
      )
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('occurred_at', { ascending: false })
      .limit(limit)

    if (error) throw new Error(error.message)
    return (data ?? []).map(this.toEventCamel)
  }

  // ── snake → camel mappers ─────────────────────────────────────

  private toPersonCamel = (row: Record<string, unknown>) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    displayName: (row.display_name as string | null) ?? null,
    primaryEmail: (row.primary_email as string | null) ?? null,
    // Overview "People" table attributes (filled by the matcher from
    // each platform). All nullable — "—" in the UI when unresolved.
    country: (row.country as string | null) ?? null,
    initialSource: (row.initial_source as string | null) ?? null,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  })

  private toIdentifierCamel = (row: Record<string, unknown>) => ({
    id: row.id as string,
    source: row.source as string,
    externalId: row.external_id as string,
    connectionId: (row.connection_id as string | null) ?? null,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
  })

  private toEventCamel = (row: Record<string, unknown>) => {
    // Supabase returns the joined definition as a nested object (or
    // array, depending on the relationship inference). Normalise to a
    // flat shape the frontend can render directly.
    const defRaw = row.event_definitions as
      | { event_key?: string; display_name?: string | null; source?: string }
      | { event_key?: string; display_name?: string | null; source?: string }[]
      | null
    const def = Array.isArray(defRaw) ? defRaw[0] : defRaw
    return {
      id: row.id as string,
      occurredAt: row.occurred_at as string,
      properties: (row.properties as Record<string, unknown>) ?? {},
      sourceEventId: row.source_event_id as string,
      connectionId: (row.connection_id as string | null) ?? null,
      eventKey: def?.event_key ?? null,
      eventLabel: def?.display_name ?? def?.event_key ?? null,
      source: def?.source ?? null,
    }
  }
}
