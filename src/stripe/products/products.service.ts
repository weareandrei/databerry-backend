import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { StripeBackfillService } from '../sync/backfill.service'

export interface StripeProductOption {
  id: string
  name: string
  active: boolean
}

export interface ProductsForConnectionResult {
  /** All products available on the underlying Stripe account. */
  products: StripeProductOption[]
  /**
   * Currently-selected product IDs for this connection.
   * Empty array = "All products" (no filter applied).
   */
  selectedProductIds: string[]
  /** True when the underlying Stripe account is fully backfilled. */
  backfillComplete: boolean
  /** Raw status — frontend uses this to render a progress banner. */
  backfillStatus: 'pending' | 'in_progress' | 'complete' | 'error' | null
  /** Last backfill error message, if `backfillStatus === 'error'`. */
  backfillError: string | null
  stripeAccountId: string | null
}

export interface StripeAccountStatus {
  stripeAccountId: string
  backfillStatus: 'pending' | 'in_progress' | 'complete' | 'error' | null
  backfilledThrough: string | null
  lastSyncedAt: string | null
  backfillError: string | null
}

/**
 * Per-connection Stripe product filter.
 *
 * The data model: a Databerry connection points at a Stripe account, the
 * account has many products, and the user picks a subset (or "all") for that
 * specific connection. The selected IDs live in a `tracked_product_ids TEXT[]`
 * column on the credential row (`connections_stripe` or
 * `connections_stripe_manual`) — `'{}'` (empty array) is the "all products"
 * sentinel.
 *
 * Two connections on the same Stripe account can have different filters; we
 * still only backfill the underlying account once.
 */
@Injectable()
export class StripeProductsService {
  private readonly logger = new Logger(StripeProductsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly backfillService: StripeBackfillService,
  ) {}

  /**
   * List all products visible on the connection's Stripe account, plus the
   * currently-selected subset for this connection. Used by the post-creation
   * picker modal and by Settings.
   */
  async listProductsForConnection(
    connectionId: string,
    userId: string,
  ): Promise<ProductsForConnectionResult> {
    const client = this.supabaseService.getClient()

    // Ownership check — same pattern as views.service
    const { data: conn } = await client
      .from('connections')
      .select('id, type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) throw new NotFoundException('Connection not found')

    // Single round trip: the credential row gives us BOTH the stripe_account_id
    // and the tracked_product_ids selection now that the latter lives there.
    const credential = await this.getCredentialForConnection(connectionId, conn.type as string)
    const stripeAccountId = credential?.stripeAccountId ?? null

    if (!stripeAccountId) {
      // Non-Stripe or unlinked Stripe connection — return an empty shell so the
      // frontend can render an "unavailable" state without throwing.
      return {
        products: [],
        selectedProductIds: [],
        backfillComplete: false,
        backfillStatus: null,
        backfillError: null,
        stripeAccountId: null,
      }
    }

    const [productsRes, accountRes] = await Promise.all([
      client
        .from('stripe_products')
        .select('id, name, active')
        .eq('stripe_account_id', stripeAccountId)
        .order('active', { ascending: false })
        .order('name', { ascending: true }),
      client
        .from('stripe_accounts')
        .select('backfill_status, backfill_error')
        .eq('id', stripeAccountId)
        .maybeSingle(),
    ])

    if (productsRes.error) throw new Error(`stripe_products read: ${productsRes.error.message}`)

    const products: StripeProductOption[] = (productsRes.data ?? []).map(r => ({
      id: r.id as string,
      name: r.name as string,
      active: Boolean(r.active),
    }))
    const selectedProductIds = credential?.trackedProductIds ?? []
    const backfillStatus =
      (accountRes.data?.backfill_status as ProductsForConnectionResult['backfillStatus']) ?? null
    const backfillError = (accountRes.data?.backfill_error as string | null) ?? null

    return {
      products,
      selectedProductIds,
      backfillComplete: backfillStatus === 'complete',
      backfillStatus,
      backfillError,
      stripeAccountId,
    }
  }

  /**
   * Replace the connection's product filter. Pass an empty array to mean
   * "All products" (no filter — every product on the account contributes).
   */
  async setProductFilter(
    connectionId: string,
    productIds: string[],
    userId: string,
  ): Promise<{ selectedProductIds: string[] }> {
    const client = this.supabaseService.getClient()

    const { data: conn } = await client
      .from('connections')
      .select('id, type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) throw new NotFoundException('Connection not found')

    const credential = await this.getCredentialForConnection(connectionId, conn.type as string)
    const stripeAccountId = credential?.stripeAccountId ?? null
    if (!stripeAccountId) {
      throw new NotFoundException('Connection is not linked to a Stripe account yet')
    }

    // De-dup is now load-bearing: a `TEXT[]` column accepts duplicates, unlike
    // the old `(connection_id, product_id)` junction PK which rejected them.
    const uniqueIds = Array.from(new Set(productIds))

    if (uniqueIds.length > 0) {
      // Verify all submitted IDs actually exist on this account so we don't
      // silently accept a typo or a product from a different account.
      const { data: known, error: knownErr } = await client
        .from('stripe_products')
        .select('id')
        .eq('stripe_account_id', stripeAccountId)
        .in('id', uniqueIds)
      if (knownErr) throw new Error(`stripe_products verify: ${knownErr.message}`)

      const knownIds = new Set((known ?? []).map(r => r.id as string))
      const unknown = uniqueIds.filter(id => !knownIds.has(id))
      if (unknown.length > 0) {
        throw new NotFoundException(
          `Unknown product id(s) for this account: ${unknown.join(', ')}`,
        )
      }
    }

    // Single UPDATE on the credential row. The credential table is dispatched
    // by connection type; same dispatch as `getCredentialForConnection`.
    const credentialTable =
      conn.type === 'stripe_manual'
        ? 'connections_stripe_manual'
        : conn.type === 'stripe'
          ? 'connections_stripe'
          : null
    if (!credentialTable) {
      // Should be unreachable — `getCredentialForConnection` returned a
      // stripeAccountId above, which only happens for the two Stripe types.
      throw new NotFoundException('Connection is not a Stripe connection')
    }

    const { error: updErr } = await client
      .from(credentialTable)
      .update({ tracked_product_ids: uniqueIds })
      .eq('connection_id', connectionId)
    if (updErr) throw new Error(`${credentialTable} tracked_product_ids update: ${updErr.message}`)

    this.logger.log(
      `  ✓ setProductFilter  connection=${connectionId}  products=[${uniqueIds.join(', ') || '<all>'}]`,
    )
    return { selectedProductIds: uniqueIds }
  }

  /**
   * Backfill status for an account — the picker modal polls this every few
   * seconds while showing "Importing 90 days of payment history…".
   *
   * Ownership: we require the requesting user to own at least one connection
   * pointing at this account so a leaked acct_xxx can't be probed by
   * unauthorised users.
   */
  /**
   * Force a backfill retry. Used after the user fixes a missing scope on
   * their Restricted Key, or to recover an account stranded in `in_progress`
   * by a server restart. Ownership is verified the same way as
   * `getAccountStatus` — at least one of the user's connections must point
   * at the account.
   */
  async retryBackfill(stripeAccountId: string, userId: string): Promise<{ ok: true }> {
    const client = this.supabaseService.getClient()
    const ownsAccount = await this.userOwnsAccount(client, stripeAccountId, userId)
    if (!ownsAccount) throw new NotFoundException('Stripe account not found')

    await this.backfillService.retryBackfill(stripeAccountId)
    this.logger.log(`  ✓ retryBackfill kicked off  account=${stripeAccountId}  user=${userId}`)
    return { ok: true }
  }

  async getAccountStatus(
    stripeAccountId: string,
    userId: string,
  ): Promise<StripeAccountStatus> {
    const client = this.supabaseService.getClient()

    const ownsAccount = await this.userOwnsAccount(client, stripeAccountId, userId)
    if (!ownsAccount) throw new NotFoundException('Stripe account not found')

    const { data, error } = await client
      .from('stripe_accounts')
      .select('id, backfill_status, backfilled_through, last_synced_at, backfill_error')
      .eq('id', stripeAccountId)
      .maybeSingle()
    if (error) throw new Error(`stripe_accounts read: ${error.message}`)
    if (!data) throw new NotFoundException('Stripe account not found')

    return {
      stripeAccountId: data.id as string,
      backfillStatus:
        (data.backfill_status as StripeAccountStatus['backfillStatus']) ?? null,
      backfilledThrough: (data.backfilled_through as string | null) ?? null,
      lastSyncedAt: (data.last_synced_at as string | null) ?? null,
      backfillError: (data.backfill_error as string | null) ?? null,
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the credential-row context for a connection in a single round trip:
   * the linked `stripe_account_id` AND the `tracked_product_ids` filter.
   *
   * Returns `null` for non-Stripe connection types (`stripe`, `stripe_manual`
   * are the only Stripe shapes — anything else has no credential row to read).
   * Returns `{ stripeAccountId: null, trackedProductIds: [] }` for a Stripe
   * connection whose credential row hasn't been linked yet (rare; mostly an
   * intermediate state during connection creation).
   */
  private async getCredentialForConnection(
    connectionId: string,
    connectionType: string,
  ): Promise<{ stripeAccountId: string | null; trackedProductIds: string[] } | null> {
    const client = this.supabaseService.getClient()

    const table =
      connectionType === 'stripe_manual'
        ? 'connections_stripe_manual'
        : connectionType === 'stripe'
          ? 'connections_stripe'
          : null
    if (!table) return null

    const { data } = await client
      .from(table)
      .select('stripe_account_id, tracked_product_ids')
      .eq('connection_id', connectionId)
      .maybeSingle()

    return {
      stripeAccountId: (data?.stripe_account_id as string | null) ?? null,
      trackedProductIds: (data?.tracked_product_ids as string[] | null) ?? [],
    }
  }

  /**
   * True iff `userId` owns at least one connection pointing at `stripeAccountId`
   * (across both manual and OAuth Stripe connection tables).
   */
  private async userOwnsAccount(
    client: ReturnType<SupabaseService['getClient']>,
    stripeAccountId: string,
    userId: string,
  ): Promise<boolean> {
    // Two parallel lookups — manual + OAuth — followed by a connection
    // ownership check for whichever rows came back.
    const [manualRes, oauthRes] = await Promise.all([
      client
        .from('connections_stripe_manual')
        .select('connection_id')
        .eq('stripe_account_id', stripeAccountId),
      client
        .from('connections_stripe')
        .select('connection_id')
        .eq('stripe_account_id', stripeAccountId),
    ])

    const connectionIds = [
      ...((manualRes.data ?? []).map(r => r.connection_id as string)),
      ...((oauthRes.data ?? []).map(r => r.connection_id as string)),
    ]
    if (connectionIds.length === 0) return false

    const { data: ownConns, error } = await client
      .from('connections')
      .select('id')
      .eq('user_id', userId)
      .in('id', connectionIds)
      .limit(1)

    if (error) throw new Error(`connections ownership check: ${error.message}`)
    return (ownConns?.length ?? 0) > 0
  }
}
