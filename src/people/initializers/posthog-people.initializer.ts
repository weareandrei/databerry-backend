import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { PeopleMatchingService } from '../people-matching.service'
import { getPosthogCredentials } from '../../posthog/connection/credentials'

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
 * Identity only — NOT events. (Event ingestion is Phase 3; the
 * decision to "track all PostHog events" applies there.)
 *
 * Re-runnable + idempotent, same as the Stripe initializer.
 */
@Injectable()
export class PosthogPeopleInitializer {
  private readonly logger = new Logger(PosthogPeopleInitializer.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly matching: PeopleMatchingService,
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

    let processed = 0
    // PostHog paginates with a fully-formed `next` URL. Start at the
    // persons endpoint; follow `next` until exhausted or the page cap.
    let url: string | null =
      `${creds.host}/api/projects/${creds.projectId}/persons/?limit=100`
    const MAX_PAGES = 100 // 100 × 100 = 10k persons per run; re-runs continue.

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
        await this.ingestPerson(userId, projectId, connectionId, person)
        processed++
      }

      url = json.next ?? null
    }

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
  ): Promise<void> {
    const distinctIds = (person.distinct_ids ?? []).filter(Boolean)
    const props = person.properties ?? {}
    const email = typeof props.email === 'string' ? props.email : null
    const name = typeof props.name === 'string' ? props.name : null

    if (distinctIds.length === 0 && !email) return

    const identifiers = distinctIds.map(did => ({
      source: 'posthog',
      externalId: did,
      connectionId,
    }))

    try {
      await this.matching.upsertPerson(userId, projectId, {
        identifiers,
        email,
        displayName: name,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Skipped PostHog person ${person.id}: ${detail}`)
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

/** Minimal shape of the PostHog person fields we consume. */
interface PosthogPerson {
  id: string | number
  distinct_ids?: string[]
  properties?: Record<string, unknown>
}
