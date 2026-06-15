import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

/**
 * One observed event occurrence for a person, from one platform pull.
 * `eventKey` identifies the TYPE (drives the `event_definitions` row);
 * `sourceEventId` is the platform's own id for THIS occurrence and is
 * the idempotency key, so re-syncs never double-insert.
 */
export interface ObservedEvent {
  /** Machine key for the event type (e.g. 'charge_succeeded',
   *  '$pageview', 'customer_created'). One definition per (connection,
   *  eventKey). */
  eventKey: string
  /** Human label for the definition / timeline row (e.g. 'Payment'). */
  displayName?: string | null
  /** When it actually happened (ISO 8601). The timeline sort key. */
  occurredAt: string
  /** The platform's own id for this occurrence — idempotency key. */
  sourceEventId: string
  /** Optional structured payload (amount, currency, …). */
  properties?: Record<string, unknown>
}

/**
 * Event-ingestion writer for the people graph (Phase 3).
 *
 * The identity initializers (Stripe / PostHog) call `recordEvents`
 * after `upsertPerson` resolves a person, handing over that person's
 * observed events. We:
 *   1. resolve each event's `event_definition` (get-or-create, cached
 *      per sync run so we don't re-upsert a definition per event), then
 *   2. idempotently upsert the occurrences into `people_events`
 *      (ON CONFLICT (connection_id, source_event_id) DO NOTHING), so
 *      overlapping pulls and re-syncs are safe.
 *
 * Every write carries `user_id` so the rows satisfy the owner-only RLS
 * policies even though we go through the service-role client.
 */
@Injectable()
export class PeopleEventsService {
  private readonly logger = new Logger(PeopleEventsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Persist a batch of events for ONE person. `defCache` is a Map the
   * CALLER owns for the duration of a sync run (eventKey → definitionId)
   * — pass the SAME map across every person in the run so a definition
   * is upserted at most once. Returns the number of rows written
   * (pre-dedupe; conflicts are silently ignored by the DB).
   */
  async recordEvents(
    userId: string,
    projectId: string,
    connectionId: string,
    source: string,
    personId: string,
    events: ObservedEvent[],
    defCache: Map<string, string>,
  ): Promise<number> {
    if (events.length === 0) return 0

    const rows: Record<string, unknown>[] = []
    for (const ev of events) {
      // Skip malformed occurrences — a missing id or timestamp can't be
      // de-duped or sorted, so it has no place on the timeline.
      if (!ev.sourceEventId || !ev.occurredAt) continue
      const defId = await this.getOrCreateDefinition(
        userId,
        projectId,
        connectionId,
        source,
        ev.eventKey,
        ev.displayName ?? null,
        defCache,
      )
      rows.push({
        project_id: projectId,
        user_id: userId,
        person_id: personId,
        event_definition_id: defId,
        connection_id: connectionId,
        source_event_id: ev.sourceEventId,
        occurred_at: ev.occurredAt,
        properties: ev.properties ?? {},
      })
    }
    if (rows.length === 0) return 0

    const { error } = await this.supabaseService
      .getClient()
      .from('people_events')
      .upsert(rows, {
        // The idempotency key — re-syncs / overlapping windows no-op.
        onConflict: 'connection_id,source_event_id',
        ignoreDuplicates: true,
      })
    if (error) throw new Error(error.message)
    return rows.length
  }

  /**
   * Resolve the `event_definitions.id` for one (connection, eventKey),
   * creating it on first sight. Cached in `defCache` for the run.
   *
   * Upsert on the `(connection_id, event_key)` unique key with
   * `ignoreDuplicates: false` so an existing definition is returned
   * (DO UPDATE … RETURNING) rather than skipped. `tracked: true` — v1
   * ingests every type it sees; the tracked gate is a later volume
   * control with no UI yet.
   */
  private async getOrCreateDefinition(
    userId: string,
    projectId: string,
    connectionId: string,
    source: string,
    eventKey: string,
    displayName: string | null,
    cache: Map<string, string>,
  ): Promise<string> {
    const cached = cache.get(eventKey)
    if (cached) return cached

    const { data, error } = await this.supabaseService
      .getClient()
      .from('event_definitions')
      .upsert(
        {
          project_id: projectId,
          user_id: userId,
          connection_id: connectionId,
          source,
          event_key: eventKey,
          display_name: displayName,
          tracked: true,
        },
        { onConflict: 'connection_id,event_key', ignoreDuplicates: false },
      )
      .select('id')
      .single()
    if (error) throw new Error(error.message)

    const id = (data as { id: string }).id
    cache.set(eventKey, id)
    return id
  }
}
