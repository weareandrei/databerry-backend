import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

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
 * specific connection. This is a junction table (`connection_stripe_products`)
 * — empty means "all products", a non-empty set means "only these".
 *
 * Two connections on the same Stripe account can have different filters; we
 * still only backfill the underlying account once.
 */
@Injectable()
export class StripeProductsService {
  private readonly logger = new Logger(StripeProductsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

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

    const stripeAccountId = await this.getStripeAccountIdForConnection(connectionId, conn.type as string)

    if (!stripeAccountId) {
      // Non-Stripe or unlinked Stripe connection — return an empty shell so the
      // frontend can render an "unavailable" state without throwing.
      return {
        products: [],
        selectedProductIds: [],
        backfillComplete: false,
        backfillStatus: null,
        stripeAccountId: null,
      }
    }

    const [productsRes, selectionRes, accountRes] = await Promise.all([
      client
        .from('stripe_products')
        .select('id, name, active')
        .eq('stripe_account_id', stripeAccountId)
        .order('active', { ascending: false })
        .order('name', { ascending: true }),
      client
        .from('connection_stripe_products')
        .select('product_id')
        .eq('connection_id', connectionId),
      client
        .from('stripe_accounts')
        .select('backfill_status')
        .eq('id', stripeAccountId)
        .maybeSingle(),
    ])

    if (productsRes.error) throw new Error(`stripe_products read: ${productsRes.error.message}`)
    if (selectionRes.error) throw new Error(`connection_stripe_products read: ${selectionRes.error.message}`)

    const products: StripeProductOption[] = (productsRes.data ?? []).map(r => ({
      id: r.id as string,
      name: r.name as string,
      active: Boolean(r.active),
    }))
    const selectedProductIds = (selectionRes.data ?? []).map(r => r.product_id as string)
    const backfillStatus =
      (accountRes.data?.backfill_status as ProductsForConnectionResult['backfillStatus']) ?? null

    return {
      products,
      selectedProductIds,
      backfillComplete: backfillStatus === 'complete',
      backfillStatus,
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

    const stripeAccountId = await this.getStripeAccountIdForConnection(connectionId, conn.type as string)
    if (!stripeAccountId) {
      throw new NotFoundException('Connection is not linked to a Stripe account yet')
    }

    // De-dup defensively — frontend should already do it, but the junction
    // PK (connection_id, product_id) would reject dupes anyway.
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

    // Replace the junction rows atomically: delete then insert. Doing it in
    // two statements is fine — the junction is small and this endpoint is
    // not on a hot path. (No Postgres function = no migration needed.)
    const { error: delErr } = await client
      .from('connection_stripe_products')
      .delete()
      .eq('connection_id', connectionId)
    if (delErr) throw new Error(`connection_stripe_products clear: ${delErr.message}`)

    if (uniqueIds.length > 0) {
      const rows = uniqueIds.map(product_id => ({ connection_id: connectionId, product_id }))
      const { error: insErr } = await client
        .from('connection_stripe_products')
        .insert(rows)
      if (insErr) throw new Error(`connection_stripe_products insert: ${insErr.message}`)
    }

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

  private async getStripeAccountIdForConnection(
    connectionId: string,
    connectionType: string,
  ): Promise<string | null> {
    const client = this.supabaseService.getClient()

    if (connectionType === 'stripe_manual') {
      const { data } = await client
        .from('connections_stripe_manual')
        .select('stripe_account_id')
        .eq('connection_id', connectionId)
        .maybeSingle()
      return (data?.stripe_account_id as string | null) ?? null
    }
    if (connectionType === 'stripe') {
      const { data } = await client
        .from('connections_stripe')
        .select('stripe_account_id')
        .eq('connection_id', connectionId)
        .maybeSingle()
      return (data?.stripe_account_id as string | null) ?? null
    }
    return null
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
