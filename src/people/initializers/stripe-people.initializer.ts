import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { PeopleMatchingService } from '../people-matching.service'
import { PeopleEventsService, type ObservedEvent } from '../people-events.service'
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
 * `customers.list` endpoint paginates simply. Per customer we also
 * ingest a small event timeline — "became a customer" plus their
 * charges — via `PeopleEventsService`; that ingestion is best-effort
 * and never fails the identity sync.
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
    private readonly events: PeopleEventsService,
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

    let processed = 0 // SUCCESSFUL upserts (not attempts)
    let firstError: string | null = null
    let startingAfter: string | undefined
    // Hard page cap so a runaway (or a customer base in the
    // hundreds of thousands) can't spin forever in one call. 100
    // pages × 100 = 10k customers per run; subsequent runs continue
    // from where the data already exists (upsert no-ops the rest).
    const MAX_PAGES = 100
    // Per-run definition cache (eventKey → definition id) so we upsert
    // each event_definition at most once, not once per occurrence.
    const defCache = new Map<string, string>()

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { limit: '100' }
      if (startingAfter) params.starting_after = startingAfter

      // `makeStripeGetter` already prefixes `https://api.stripe.com/v1/`
      // — pass a BARE resource path (like every other Stripe caller),
      // not `/v1/customers`, or the URL doubles up to `/v1//v1/...`.
      const body = (await getter('customers', params)) as {
        data?: StripeCustomer[]
        has_more?: boolean
      }
      const customers = body.data ?? []
      if (customers.length === 0) break

      for (const cus of customers) {
        try {
          await this.ingestCustomer(userId, projectId, connectionId, cus, getter, defCache)
          processed++
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          if (!firstError) firstError = detail
          this.logger.warn(`Skipped Stripe customer ${cus.id}: ${detail}`)
        }
      }

      if (!body.has_more) break
      startingAfter = customers[customers.length - 1]?.id
      if (!startingAfter) break
    }

    // Attempted customers but NONE succeeded → the failure is systemic
    // (missing `people*` migration, broken creds, RLS) rather than a
    // few bad rows. Surface it loudly instead of returning a hollow
    // "success" with zero people that reads as "no users" in the UI.
    if (processed === 0 && firstError) {
      throw new Error(`No Stripe customers could be synced — ${firstError}`)
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
    getter: StripeGetter,
    defCache: Map<string, string>,
  ): Promise<void> {
    if (cus.deleted || !cus.id) return

    // Charges drive BOTH "last seen" and the payment timeline, so fetch
    // them up front. Best-effort: a charges hiccup degrades to
    // first-seen + an identity-only sync, never a hard failure.
    const charges = await this.fetchChargesSafe(getter, cus.id)

    // Throws on failure — the caller's loop counts successes, logs
    // per-row failures, and escalates an all-failed batch.
    const personId = await this.matching.upsertPerson(userId, projectId, {
      identifiers: [
        { source: 'stripe', externalId: cus.id, connectionId },
      ],
      email: cus.email ?? null,
      displayName: cus.name ?? null,
      // Billing-address country (ISO alpha-2) when set. No traffic
      // source for a card payment → initial_source stays null.
      country: cus.address?.country ?? null,
      // LAST SEEN = the most recent of their charges, else the customer
      // creation time. `customer.created` alone is FIRST-seen, so an
      // active payer would otherwise look stale.
      lastSeenAt: this.resolveLastSeen(cus, charges),
    })

    // Event timeline — BEST EFFORT. A bad row must not fail the identity
    // sync (which already succeeded).
    try {
      await this.recordCustomerEvents(userId, projectId, connectionId, personId, cus, charges, defCache)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Stripe events skipped for ${cus.id}: ${detail}`)
    }
  }

  /**
   * "Last seen" for a Stripe customer = the latest of their charges'
   * timestamps, falling back to `customer.created`. ISO-8601 UTC.
   */
  private resolveLastSeen(cus: StripeCustomer, charges: StripeCharge[]): string | null {
    let maxEpoch = cus.created ?? 0
    for (const ch of charges) {
      if (ch.created && ch.created > maxEpoch) maxEpoch = ch.created
    }
    return maxEpoch > 0 ? new Date(maxEpoch * 1000).toISOString() : null
  }

  /**
   * Build + persist one customer's event timeline from PRE-FETCHED
   * charges: a "Became a customer" marker (from `customer.created`)
   * plus each charge as a payment event. `source_event_id` is the
   * Stripe object id, so re-syncs are idempotent.
   */
  private async recordCustomerEvents(
    userId: string,
    projectId: string,
    connectionId: string,
    personId: string,
    cus: StripeCustomer,
    charges: StripeCharge[],
    defCache: Map<string, string>,
  ): Promise<void> {
    const events: ObservedEvent[] = []

    if (cus.created) {
      events.push({
        eventKey: 'customer_created',
        displayName: 'Became a customer',
        occurredAt: new Date(cus.created * 1000).toISOString(),
        // Synthetic id (the customer has no distinct "created" event id).
        sourceEventId: `${cus.id}:customer_created`,
        properties: {},
      })
    }

    for (const ch of charges) {
      if (!ch.id || !ch.created) continue
      const succeeded = ch.status === 'succeeded'
      events.push({
        eventKey: succeeded ? 'charge_succeeded' : 'charge_failed',
        displayName: succeeded ? 'Payment' : 'Failed payment',
        occurredAt: new Date(ch.created * 1000).toISOString(),
        sourceEventId: ch.id,
        properties: {
          amount: ch.amount ?? null,
          currency: ch.currency ?? null,
          status: ch.status ?? null,
        },
      })
    }

    await this.events.recordEvents(
      userId,
      projectId,
      connectionId,
      'stripe',
      personId,
      events,
      defCache,
    )
  }

  /** `fetchCharges` wrapped so a fetch failure yields `[]` (and a log)
   *  rather than blocking the customer's identity sync. */
  private async fetchChargesSafe(getter: StripeGetter, customerId: string): Promise<StripeCharge[]> {
    try {
      return await this.fetchCharges(getter, customerId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Stripe charges fetch failed for ${customerId}: ${detail}`)
      return []
    }
  }

  /**
   * A customer's most recent charges (cap 50 — enough for a timeline
   * without an N+1 firehose; older charges fall off the bottom). One
   * GET per customer; acceptable at the people counts we sync, and the
   * place to batch-optimise (via `/v1/events`) if volume grows.
   */
  private async fetchCharges(getter: StripeGetter, customerId: string): Promise<StripeCharge[]> {
    // BARE path — `makeStripeGetter` prefixes `https://api.stripe.com/v1/`.
    const body = (await getter('charges', { customer: customerId, limit: '50' })) as {
      data?: StripeCharge[]
    }
    return body.data ?? []
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
  /** Unix epoch (seconds) the customer was created. */
  created?: number
  /** Billing address; `country` is ISO 3166-1 alpha-2. */
  address?: { country?: string | null } | null
}

/** Minimal shape of the Stripe charge fields we turn into events. */
interface StripeCharge {
  id: string
  /** Unix epoch (seconds) the charge was created. */
  created?: number
  /** Smallest currency unit (e.g. cents). */
  amount?: number
  currency?: string
  /** 'succeeded' | 'pending' | 'failed'. */
  status?: string
}
