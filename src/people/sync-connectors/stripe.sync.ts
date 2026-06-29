import { Injectable, Logger } from '@nestjs/common'
import { ConnectionsRepository } from '../../connections/connections.repository'
import { PeopleRepository } from '../people.repository'
import { PeopleMatchingService } from '../people-matching.service'
import { PeopleEventsService, type ObservedEvent } from '../people-events.service'
import { PeopleSyncStatus } from '../sync-status'
import { StripeApiClient } from '../../stripe/stripe-api.client'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

/**
 * Stripe → people sync. Pulls every customer from a Stripe connection and feeds each into
 * `PeopleMatchingService.upsertPerson`, so a Stripe customer becomes
 * a `people` row carrying two identifiers: its `cus_…` id and its
 * email. The email is the bridge — once PostHog / GA syncs
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
 * Re-runnable: `upsertPerson` is idempotent, so re-syncing an
 * already-synced connection just refreshes `last_seen_at` and fills
 * any newly-available name/email. Safe to call on every connection
 * create AND on a schedule.
 */
@Injectable()
export class StripeSync {
  private readonly logger = new Logger(StripeSync.name)

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly peopleRepository: PeopleRepository,
    private readonly matching: PeopleMatchingService,
    private readonly events: PeopleEventsService,
  ) {}

  /**
   * Sync people for one Stripe connection into one project.
   *
   * @param connectionId  the `connections.id` (type 'stripe' or
   *                      'stripe_manual')
   * @param projectId     project the resulting people belong to
   * @param userId        owner — scopes every write for RLS
   * @returns count of customers processed
   */
  async sync(
    connectionId: string,
    projectId: string,
    userId: string,
  ): Promise<{ processed: number }> {
    const client = await this.resolveStripeClient(connectionId, userId)
    const eventDefinitionsCache = new Map<string, string>()

    const { processed, firstError, completed } = await this.syncCustomersIncremental(
      client,
      userId,
      projectId,
      connectionId,
      eventDefinitionsCache,
    )

    // Attempted customers but NONE succeeded → the failure is systemic
    // (missing `people*` migration, broken creds, RLS) rather than a
    // few bad rows. Surface it loudly instead of returning a hollow
    // "success" with zero people that reads as "no users" in the UI.
    if (processed === 0 && firstError) {
      throw new Error(`No Stripe customers could be synced — ${firstError}`)
    }

    await this.markSynced(connectionId, projectId, userId, completed)
    this.logger.log(
      `Stripe people sync done  connection=${connectionId} project=${projectId} customers=${processed}`,
    )
    return { processed }
  }

  /**
   * Incrementally sync Stripe customers into people, resuming from the saved
   * cursor so we don't re-pull everything on every run.
   *
   * Stripe lists customers DESCENDING by `created` (no ascending option), so:
   *   - We fetch only `created >= syncedThroughCreated` (the watermark from the
   *     last completed scan), skipping customers already pulled.
   *   - We checkpoint the pagination position (`resumeAfterId`) after every
   *     batch, so a crash redoes only the in-flight batch.
   *   - We DON'T advance the `created` watermark until the whole scan finishes —
   *     an older batch completing first must not move the incremental floor past
   *     newer customers that aren't synced yet.
   *
   * Idempotent regardless of the cursor: `upsertPerson` and the
   * `(connection_id, source_event_id)` unique key dedupe any re-pulled rows, so
   * a stale or overlapping cursor can never double-write.
   *
   * NOTE: this catches NEW customers, not edits / new charges on customers
   * synced in a previous run — that needs an Events API watermark (follow-up).
   */
  private async syncCustomersIncremental(
    client: StripeApiClient,
    userId: string,
    projectId: string,
    connectionId: string,
    eventDefinitionsCache: Map<string, string>,
  ): Promise<StripeSyncResult & { completed: boolean }> {
    const MAX_BATCHES = 100 // safety cap (~10k customers/run); resumes next run
    const cursor = await this.readCustomerCursor(connectionId, userId)

    let progress: StripeSyncResult = { processed: 0, firstError: null }
    let resumeAfterId = cursor.resumeAfterId ?? undefined
    let newestCreated = cursor.pendingNewestCreated ?? cursor.syncedThroughCreated
    // False until the scan reaches the end of the customer list. When we exit
    // by hitting MAX_BATCHES it stays false → the cursor keeps `resumeAfterId`
    // and the connection is reported as still backfilling.
    let completed = false

    for (let batchIndex = 0; batchIndex < MAX_BATCHES; batchIndex++) {
      const { customers, hasMore } = await this.fetchCustomerBatch(client, {
        createdGte: cursor.syncedThroughCreated,
        startingAfter: resumeAfterId,
      })
      if (customers.length === 0) {
        await this.completeCustomerCursor(connectionId, projectId, userId, newestCreated)
        completed = true
        break
      }

      const batchNewest = customers.reduce(
        (max, customer) => Math.max(max, customer.created ?? 0),
        0,
      )
      if (batchNewest > 0) newestCreated = Math.max(newestCreated ?? 0, batchNewest)

      progress = await this.ingestCustomerBatch(
        client,
        userId,
        projectId,
        connectionId,
        eventDefinitionsCache,
        customers,
        progress,
      )

      const lastCustomerId = customers[customers.length - 1]?.id
      if (!hasMore || !lastCustomerId) {
        await this.completeCustomerCursor(connectionId, projectId, userId, newestCreated)
        completed = true
        break
      }

      // Per-batch checkpoint: advance the pagination position, keep the
      // watermark put until the scan completes.
      resumeAfterId = lastCustomerId
      await this.checkpointCustomerCursor(connectionId, projectId, userId, {
        syncedThroughCreated: cursor.syncedThroughCreated,
        resumeAfterId: lastCustomerId,
        pendingNewestCreated: newestCreated,
      })
    }

    return { ...progress, completed }
  }

  /** Ingest one batch of customers, accumulating successes + the first error. */
  private async ingestCustomerBatch(
    client: StripeApiClient,
    userId: string,
    projectId: string,
    connectionId: string,
    eventDefinitionsCache: Map<string, string>,
    customers: StripeCustomer[],
    progress: StripeSyncResult,
  ): Promise<StripeSyncResult> {
    return customers.reduce(async (progressPromise, customer) => {
      const current = await progressPromise
      try {
        await this.ingestCustomer(
          userId,
          projectId,
          connectionId,
          customer,
          client,
          eventDefinitionsCache,
        )
        return { processed: current.processed + 1, firstError: current.firstError }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.logger.warn(`Skipped Stripe customer ${customer.id}: ${detail}`)
        return {
          processed: current.processed,
          firstError: current.firstError ?? detail,
        }
      }
    }, Promise.resolve(progress))
  }

  private async fetchCustomerBatch(
    client: StripeApiClient,
    options: { createdGte: number | null; startingAfter?: string },
  ): Promise<{ customers: StripeCustomer[]; hasMore: boolean }> {
    const params: Record<string, string> = { limit: '100' }
    // Incremental floor — only customers created at/after the last completed
    // scan. `gte` (not `gt`) + idempotent upserts safely re-pull the boundary
    // second rather than risk skipping same-second siblings.
    if (options.createdGte != null) params['created[gte]'] = String(options.createdGte)
    if (options.startingAfter) params.starting_after = options.startingAfter

    // `StripeApiClient.get` already prefixes `https://api.stripe.com/v1/`
    // — pass a BARE resource path (like every other Stripe caller),
    // not `/v1/customers`, or the URL doubles up to `/v1//v1/...`.
    const body = (await client.get('customers', params)) as {
      data?: StripeCustomer[]
      has_more?: boolean
    }
    return {
      customers: body.data ?? [],
      hasMore: body.has_more ?? false,
    }
  }

  /** Read + parse the saved customer-scan cursor (defaults when absent/corrupt). */
  private async readCustomerCursor(
    connectionId: string,
    userId: string,
  ): Promise<StripeCustomerSyncCursor> {
    const empty: StripeCustomerSyncCursor = {
      syncedThroughCreated: null,
      resumeAfterId: null,
      pendingNewestCreated: null,
    }
    const { data, error } = await this.peopleRepository.findSyncCursor(connectionId, userId)
    if (error) {
      this.logger.warn(`Could not read sync cursor for ${connectionId}: ${error.message}`)
      return empty
    }
    const raw = (data as { cursor?: string | null } | null)?.cursor
    if (!raw) return empty
    try {
      const parsed = JSON.parse(raw) as Partial<StripeCustomerSyncCursor>
      return {
        syncedThroughCreated: parsed.syncedThroughCreated ?? null,
        resumeAfterId: parsed.resumeAfterId ?? null,
        pendingNewestCreated: parsed.pendingNewestCreated ?? null,
      }
    } catch {
      this.logger.warn(`Ignoring corrupt sync cursor for ${connectionId}`)
      return empty
    }
  }

  /** Persist the in-progress cursor after a batch (best-effort). */
  private async checkpointCustomerCursor(
    connectionId: string,
    projectId: string,
    userId: string,
    cursor: StripeCustomerSyncCursor,
  ): Promise<void> {
    const { error } = await this.peopleRepository.upsertSyncState({
      connection_id: connectionId,
      project_id: projectId,
      user_id: userId,
      cursor: JSON.stringify(cursor),
    })
    if (error) {
      this.logger.warn(`Could not checkpoint sync cursor for ${connectionId}: ${error.message}`)
    }
  }

  /** Promote the watermark once a full scan completes; clear in-progress state. */
  private async completeCustomerCursor(
    connectionId: string,
    projectId: string,
    userId: string,
    newestCreated: number | null,
  ): Promise<void> {
    await this.checkpointCustomerCursor(connectionId, projectId, userId, {
      syncedThroughCreated: newestCreated,
      resumeAfterId: null,
      pendingNewestCreated: null,
    })
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
    customer: StripeCustomer,
    client: StripeApiClient,
    eventDefinitionsCache: Map<string, string>,
  ): Promise<void> {
    if (customer.deleted || !customer.id) return

    // Charges drive BOTH "last seen" and the payment timeline, so fetch
    // them up front. Best-effort: a charges hiccup degrades to
    // first-seen + an identity-only sync, never a hard failure.
    const charges = await this.fetchChargesSafe(client, customer.id)

    // Throws on failure — the caller's loop counts successes, logs
    // per-row failures, and escalates an all-failed batch.
    const personId = await this.matching.upsertPerson(userId, projectId, {
      identifiers: [
        { source: 'stripe', externalId: customer.id, connectionId },
      ],
      email: customer.email ?? null,
      displayName: customer.name ?? null,
      // Billing-address country (ISO alpha-2) when set. No traffic
      // source for a card payment → initial_source stays null.
      country: customer.address?.country ?? null,
      // LAST SEEN = the most recent of their charges, else the customer
      // creation time. `customer.created` alone is FIRST-seen, so an
      // active payer would otherwise look stale.
      lastSeenAt: this.resolveLastSeen(customer, charges),
    })

    // Event timeline — BEST EFFORT. A bad row must not fail the identity
    // sync (which already succeeded).
    try {
      await this.recordCustomerEvents(
        userId,
        projectId,
        connectionId,
        personId,
        customer,
        charges,
        eventDefinitionsCache,
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Stripe events skipped for ${customer.id}: ${detail}`)
    }
  }

  /**
   * "Last seen" for a Stripe customer = the latest of their charges'
   * timestamps, falling back to `customer.created`. ISO-8601 UTC.
   */
  private resolveLastSeen(
    customer: StripeCustomer,
    charges: StripeCharge[],
  ): string | null {
    const chargeEpochs = charges.map((charge) => charge.created ?? 0)
    const maxEpoch = Math.max(customer.created ?? 0, ...chargeEpochs)
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
    customer: StripeCustomer,
    charges: StripeCharge[],
    eventDefinitionsCache: Map<string, string>,
  ): Promise<void> {
    const events: ObservedEvent[] = []

    if (customer.created) {
      events.push({
        eventKey: 'customer_created',
        displayName: 'Became a customer',
        occurredAt: new Date(customer.created * 1000).toISOString(),
        // Synthetic id (the customer has no distinct "created" event id).
        sourceEventId: `${customer.id}:customer_created`,
        properties: {},
      })
    }

    for (const charge of charges) {
      if (!charge.id || !charge.created) continue
      const succeeded = charge.status === 'succeeded'
      events.push({
        eventKey: succeeded ? 'charge_succeeded' : 'charge_failed',
        displayName: succeeded ? 'Payment' : 'Failed payment',
        occurredAt: new Date(charge.created * 1000).toISOString(),
        sourceEventId: charge.id,
        properties: {
          amount: charge.amount ?? null,
          currency: charge.currency ?? null,
          status: charge.status ?? null,
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
      eventDefinitionsCache,
    )
  }

  /** `fetchCharges` wrapped so a fetch failure yields `[]` (and a log)
   *  rather than blocking the customer's identity sync. */
  private async fetchChargesSafe(client: StripeApiClient, customerId: string): Promise<StripeCharge[]> {
    try {
      return await this.fetchCharges(client, customerId)
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
  private async fetchCharges(client: StripeApiClient, customerId: string): Promise<StripeCharge[]> {
    // BARE path — `StripeApiClient.get` prefixes `https://api.stripe.com/v1/`.
    const body = (await client.get('charges', { customer: customerId, limit: '50' })) as {
      data?: StripeCharge[]
    }
    return body.data ?? []
  }

  /**
   * Resolve a `StripeApiClient` for the connection, handling both
   * manual (API key) and Connect (access token) credential rows.
   * Mirrors the decrypt-on-read pattern the rest of the Stripe
   * module uses.
   */
  private async resolveStripeClient(
    connectionId: string,
    userId: string,
  ): Promise<StripeApiClient> {
    const { data: connection, error } = await this.connectionsRepository.findTypeById(
      connectionId,
      userId,
    )
    if (error) throw new Error(error.message)
    if (!connection) throw new Error(`Connection ${connectionId} not found for user`)

    const connectionType = (connection as { type: string }).type

    if (connectionType === 'stripe_manual') {
      const { data: manualCredentials } =
        await this.connectionsRepository.getManualApiKey(connectionId)
      if (!manualCredentials?.api_key) {
        throw new Error('Stripe manual credentials not found')
      }
      const apiKey = manualCredentials.api_key as string
      return new StripeApiClient(
        isEncrypted(apiKey) ? decryptForUser(apiKey, userId) : apiKey,
      )
    }

    if (connectionType === 'stripe') {
      const { data: connectCredentials } =
        await this.connectionsRepository.getConnectAccessToken(connectionId)
      if (!connectCredentials?.access_token) {
        throw new Error('Stripe Connect credentials not found')
      }
      const accessToken = connectCredentials.access_token as string
      return new StripeApiClient(
        isEncrypted(accessToken) ? decryptForUser(accessToken, userId) : accessToken,
      )
    }

    throw new Error(`Unknown Stripe connection type '${connectionType}'`)
  }

  /**
   * Light sync bookkeeping — record that this connection's people
   * were synced. Upsert on the `connection_id` PK so re-runs just bump
   * the timestamp. We deliberately DON'T touch `last_event_at` (that's
   * the event-ingestion watchdog's column, Phase 3).
   *
   * `completed` reflects whether the customer scan reached the end this
   * run: a capped run leaves it false → `backfilling`, which tells the
   * orchestrator to re-trigger and continue from the saved cursor.
   */
  private async markSynced(
    connectionId: string,
    projectId: string,
    userId: string,
    completed: boolean,
  ): Promise<void> {
    const { error } = await this.peopleRepository.upsertSyncState({
      connection_id: connectionId,
      project_id: projectId,
      user_id: userId,
      last_synced_at: new Date().toISOString(),
      last_status: completed ? PeopleSyncStatus.Initialized : PeopleSyncStatus.Backfilling,
      last_error: null,
    })
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

type StripeSyncResult = { processed: number; firstError: string | null }

/**
 * Saved progress for a connection's customer scan, stored as JSON in
 * `connection_sync_state.cursor`.
 */
type StripeCustomerSyncCursor = {
  /** `created` (unix s) of the newest customer from the last COMPLETED scan;
   *  the incremental floor for the next run. Null before the first full scan. */
  syncedThroughCreated: number | null
  /** Stripe `starting_after` id to resume an interrupted scan; null when idle. */
  resumeAfterId: string | null
  /** Newest `created` seen during an in-progress scan; promoted to
   *  `syncedThroughCreated` when the scan finishes. */
  pendingNewestCreated: number | null
}
