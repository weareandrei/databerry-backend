import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { PeopleMatchingService } from '../people-matching.service'
import {
  makeStripeGetter,
  type StripeGetter,
} from '../../stripe/views/stripe-api.helpers'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

/**
 * Stripe → people initializer (Phase 2, first adapter).
 *
 * Pulls every customer from a Stripe connection and feeds each into
 * `PeopleMatchingService.upsertPerson`, so a Stripe customer becomes
 * a `people` row carrying two identifiers: its `cus_…` id and its
 * email. The email is the bridge — once PostHog / GA initializers
 * run and surface the same email, the matcher collapses them onto
 * this same person.
 *
 * Stripe is the cleanest first adapter: low volume (no event
 * firehose), every customer carries an email + name, and the
 * `customers.list` endpoint paginates simply. No event ingestion
 * here — this is identity only (Phase 3 handles charges/subs as
 * events).
 *
 * Re-runnable: `upsertPerson` is idempotent, so re-initializing an
 * already-synced connection just refreshes `last_seen_at` and fills
 * any newly-available name/email. Safe to call on every connection
 * create AND on a schedule.
 */
@Injectable()
export class StripePeopleInitializer {
  private readonly logger = new Logger(StripePeopleInitializer.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly matching: PeopleMatchingService,
  ) {}

  /**
   * Initialize people for one Stripe connection into one project.
   *
   * @param connectionId  the `connections.id` (type 'stripe' or
   *                      'stripe_manual')
   * @param projectId     project the resulting people belong to
   * @param userId        owner — scopes every write for RLS
   * @returns count of customers processed
   */
  async initialize(
    connectionId: string,
    projectId: string,
    userId: string,
  ): Promise<{ processed: number }> {
    const getter = await this.resolveGetter(connectionId, userId)

    let processed = 0
    let startingAfter: string | undefined
    // Hard page cap so a runaway (or a customer base in the
    // hundreds of thousands) can't spin forever in one call. 100
    // pages × 100 = 10k customers per run; subsequent runs continue
    // from where the data already exists (upsert no-ops the rest).
    const MAX_PAGES = 100

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { limit: '100' }
      if (startingAfter) params.starting_after = startingAfter

      const body = (await getter('/v1/customers', params)) as {
        data?: StripeCustomer[]
        has_more?: boolean
      }
      const customers = body.data ?? []
      if (customers.length === 0) break

      for (const cus of customers) {
        await this.ingestCustomer(userId, projectId, connectionId, cus)
        processed++
      }

      if (!body.has_more) break
      startingAfter = customers[customers.length - 1]?.id
      if (!startingAfter) break
    }

    await this.markSynced(connectionId, projectId, userId)
    this.logger.log(
      `Stripe people init done  connection=${connectionId} project=${projectId} customers=${processed}`,
    )
    return { processed }
  }

  /**
   * Map one Stripe customer → one `upsertPerson` call. Skip
   * deleted customers (Stripe returns them with `deleted: true` and
   * no usable fields) and customers with neither email nor a usable
   * id (shouldn't happen, but the matcher rejects identifier-less
   * input).
   */
  private async ingestCustomer(
    userId: string,
    projectId: string,
    connectionId: string,
    cus: StripeCustomer,
  ): Promise<void> {
    if (cus.deleted || !cus.id) return
    try {
      await this.matching.upsertPerson(userId, projectId, {
        identifiers: [
          { source: 'stripe', externalId: cus.id, connectionId },
        ],
        email: cus.email ?? null,
        displayName: cus.name ?? null,
      })
    } catch (err) {
      // One bad customer shouldn't abort the whole page. Log + move
      // on; the next run retries it (idempotent).
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Skipped Stripe customer ${cus.id}: ${detail}`)
    }
  }

  /**
   * Resolve a `StripeGetter` for the connection, handling both
   * manual (API key) and Connect (access token) credential rows.
   * Mirrors the decrypt-on-read pattern the rest of the Stripe
   * module uses.
   */
  private async resolveGetter(
    connectionId: string,
    userId: string,
  ): Promise<StripeGetter> {
    const client = this.supabaseService.getClient()

    // Ownership + type from the base connection row.
    const { data: conn, error } = await client
      .from('connections')
      .select('type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!conn) throw new Error(`Connection ${connectionId} not found for user`)

    const type = (conn as { type: string }).type

    if (type === 'stripe_manual') {
      const { data } = await client
        .from('connections_stripe_manual')
        .select('api_key')
        .eq('connection_id', connectionId)
        .maybeSingle()
      if (!data?.api_key) throw new Error('Stripe manual credentials not found')
      const raw = data.api_key as string
      return makeStripeGetter(isEncrypted(raw) ? decryptForUser(raw, userId) : raw)
    }

    // Stripe Connect (OAuth) — access token acts on the linked account.
    const { data } = await client
      .from('connections_stripe')
      .select('access_token')
      .eq('connection_id', connectionId)
      .maybeSingle()
    if (!data?.access_token) throw new Error('Stripe Connect credentials not found')
    const raw = data.access_token as string
    return makeStripeGetter(isEncrypted(raw) ? decryptForUser(raw, userId) : raw)
  }

  /**
   * Light sync bookkeeping — record that this connection's people
   * were initialized. Upsert on the `connection_id` PK so re-runs
   * just bump the timestamp. We deliberately DON'T touch
   * `last_event_at` (that's the event-ingestion watchdog's column,
   * Phase 3).
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
      // Non-fatal — the people themselves are already written. Just
      // means the watchdog has no timestamp for this run.
      this.logger.warn(`Could not record sync state for ${connectionId}: ${error.message}`)
    }
  }
}

/** Minimal shape of the Stripe customer fields we consume. */
interface StripeCustomer {
  id: string
  email?: string | null
  name?: string | null
  deleted?: boolean
}
