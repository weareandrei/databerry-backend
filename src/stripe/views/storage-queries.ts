import type { SupabaseService } from '../../supabase/supabase.service'
import { localMidnightUtc } from '../../common/tz'
import {
  subItemsTouchProducts,
  type PersistedSubItem,
} from '../sync/mrr.helper'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * `YYYY-MM-DD` + 1 day, as `YYYY-MM-DD`. Used as the exclusive upper bound
 * of a charge-date range — together with `localMidnightUtc` this gives us
 * a half-open `[from, toExclusive)` interval whose endpoints sit at the
 * user's local midnight rather than UTC midnight.
 */
function addOneDay(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(n => parseInt(n, 10))
  // Date.UTC handles month/year rollover for us.
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const yy = next.getUTCFullYear()
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(next.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export interface ChargeRow {
  amount: number
  created: string // ISO timestamp
}

/**
 * Resolve the stripe_account_id behind a connection (manual or OAuth).
 * Returns null if the connection isn't a Stripe one or the column hasn't
 * been populated yet.
 */
export async function getStripeAccountIdForConnection(
  client: Client,
  connectionId: string,
): Promise<string | null> {
  const { data: conn } = await client
    .from('connections')
    .select('type')
    .eq('id', connectionId)
    .maybeSingle()

  if (!conn) return null
  const type = conn.type as string

  if (type === 'stripe_manual') {
    const { data } = await client
      .from('connections_stripe_manual')
      .select('stripe_account_id')
      .eq('connection_id', connectionId)
      .maybeSingle()
    return (data?.stripe_account_id as string | null) ?? null
  }
  if (type === 'stripe') {
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
 * Returns the connection's product filter as a list of product IDs.
 * Empty list means "no filter" (i.e. all products) — caller should NOT add a
 * `WHERE product_id IN (...)` clause when the list is empty.
 *
 * Storage: a `tracked_product_ids TEXT[]` column on the credential row
 * (`connections_stripe` for OAuth, `connections_stripe_manual` for API keys).
 * `'{}'` (empty array) is the "all products" sentinel — same convention the
 * old `connection_stripe_products` junction had with zero rows.
 */
export async function getConnectionProductFilter(
  client: Client,
  connectionId: string,
): Promise<string[]> {
  // Need the connection type first so we know which credential table to read.
  // Non-Stripe connections (or unlinked rows) return `[]` — the "no filter"
  // path the caller is already prepared for.
  const { data: conn } = await client
    .from('connections')
    .select('type')
    .eq('id', connectionId)
    .maybeSingle()

  if (!conn) return []
  const type = conn.type as string

  const table =
    type === 'stripe_manual'
      ? 'connections_stripe_manual'
      : type === 'stripe'
        ? 'connections_stripe'
        : null
  if (!table) return []

  const { data, error } = await client
    .from(table)
    .select('tracked_product_ids')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (error) throw new Error(`${table} tracked_product_ids read: ${error.message}`)
  return (data?.tracked_product_ids as string[] | null) ?? []
}

/**
 * Pull every succeeded charge for an account over [from, to] (inclusive both
 * ends, UTC date strings). When `productIds` is non-empty, joins line_items
 * and only counts the portion of each charge attributed to those products
 * (so a $30 charge with one $20 line item for product A and one $10 line
 * item for product B sums as $20 when filtered to A).
 *
 * Returns charge-level rows (not line-item rows), with `amount` already
 * adjusted for the product filter when applicable. This shape lets
 * downstream bucket-stitching code stay agnostic to whether a filter is
 * active.
 *
 * Important: charges with NO line items (raw PaymentIntents → "unattributed")
 * are excluded when a product filter is active, because we can't attribute
 * them. They DO appear in unfiltered queries.
 */
export async function fetchAccountCharges(
  client: Client,
  stripeAccountId: string,
  dateFrom: string,
  dateTo: string,
  productIds: string[] = [],
  tz: string = 'UTC',
): Promise<ChargeRow[]> {
  // tz-aware bounds: "today" means midnight-to-midnight in the user's
  // timezone, expressed as UTC instants. For UTC users this collapses to
  // the legacy `${dateFrom}T00:00:00Z` form; for everyone else a charge
  // created at 11pm Bucharest local on Apr 30 still falls inside Apr 30
  // even though its UTC stamp is Apr 30 20:00.
  const fromISO = localMidnightUtc(dateFrom, tz).toISOString()
  const toExclusiveISO = localMidnightUtc(addOneDay(dateTo), tz).toISOString()

  if (productIds.length === 0) {
    // Fast path — no product filter, sum charges directly.
    const { data, error } = await client
      .from('stripe_charges')
      .select('amount, created')
      .eq('stripe_account_id', stripeAccountId)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)

    if (error) throw new Error(`stripe_charges read: ${error.message}`)
    return (data ?? []).map(r => ({
      amount: Number(r.amount),
      created: r.created as string,
    }))
  }

  // Filtered path — sum line-item amounts, group back into "synthetic charges"
  // keyed by charge_id so the caller can still bucket by `created`. We do
  // this in two queries (line items, then their parent charges) because
  // Supabase's PostgREST embedding doesn't aggregate cleanly here.
  const { data: liRows, error: liErr } = await client
    .from('stripe_line_items')
    .select('charge_id, amount')
    .eq('stripe_account_id', stripeAccountId)
    .in('product_id', productIds)

  if (liErr) throw new Error(`stripe_line_items read: ${liErr.message}`)
  if (!liRows || liRows.length === 0) return []

  const sumByCharge = new Map<string, number>()
  for (const li of liRows) {
    const id = li.charge_id as string
    sumByCharge.set(id, (sumByCharge.get(id) ?? 0) + Number(li.amount))
  }

  const chargeIds = Array.from(sumByCharge.keys())
  const { data: chargeRows, error: chargeErr } = await client
    .from('stripe_charges')
    .select('id, created')
    .in('id', chargeIds)
    .eq('status', 'succeeded')
    .gte('created', fromISO)
    .lt('created', toExclusiveISO)

  if (chargeErr) throw new Error(`stripe_charges read (filtered): ${chargeErr.message}`)

  return (chargeRows ?? []).map(r => ({
    amount: sumByCharge.get(r.id as string) ?? 0,
    created: r.created as string,
  }))
}

// `nextDayISO` was the UTC-only predecessor of
// `localMidnightUtc(addOneDay(dateTo), tz)`. Removed once `tz` was threaded
// through every charge-range read; if you find yourself wanting it back,
// you almost certainly mean the tz-aware form.

// ──────────────────────────────────────────────────────────────────────────
// SaaS-metric reads (MRR, active subs, top customers, churn). All operate on
// `stripe_subscriptions` + `stripe_customers`, populated by the sync layer.
// Per-connection product filter (when `productIds.length > 0`) is applied
// in-app via JSONB walk on `items`. JSONB-walk overhead is fine at the
// solo-founder scale we target (most accounts have <1k subs).
// ──────────────────────────────────────────────────────────────────────────

export interface ActiveSubsAndMrrResult {
  activeSubs: number
  mrrCents: number
}

const ACTIVE_STATUSES = ['active', 'trialing'] as const

/**
 * Active-subs count + total MRR (cents). Both metrics share a query because
 * they read the same row set; splitting them would double the I/O for no
 * gain. Applies the per-connection product filter when `productIds` is
 * non-empty: a sub counts iff at least one of its items references one of
 * `productIds`.
 */
export async function fetchActiveSubsAndMrr(
  client: Client,
  stripeAccountId: string,
  productIds: string[] = [],
): Promise<ActiveSubsAndMrrResult> {
  const { data, error } = await client
    .from('stripe_subscriptions')
    .select('id, monthly_amount_cents, items')
    .eq('stripe_account_id', stripeAccountId)
    .in('status', ACTIVE_STATUSES as unknown as string[])

  if (error) throw new Error(`stripe_subscriptions read (mrr): ${error.message}`)

  const rows = data ?? []
  if (productIds.length === 0) {
    // Fast path — no filter, sum directly.
    let mrr = 0
    for (const r of rows) mrr += Number(r.monthly_amount_cents) || 0
    return { activeSubs: rows.length, mrrCents: mrr }
  }

  // Filter path — JSONB walk to keep only subs touching the product set.
  let activeSubs = 0
  let mrr = 0
  for (const r of rows) {
    const items = (r.items as PersistedSubItem[] | null) ?? []
    if (!subItemsTouchProducts(items, productIds)) continue
    activeSubs++
    mrr += Number(r.monthly_amount_cents) || 0
  }
  return { activeSubs, mrrCents: mrr }
}

export interface TopCustomerRow {
  customerId: string
  name: string | null
  email: string | null
  /** ISO 3166-1 alpha-2 (e.g. 'RO'). Null when Stripe never collected an
   *  address for the customer, or the address has no country. */
  addressCountry: string | null
  addressCity: string | null
  amountCents: number
}

/**
 * Top N customers by gross revenue over [dateFrom, dateTo]. Reuses
 * `fetchAccountCharges` so the per-connection product filter applies for
 * free — the returned charge rows already have the right amount-attribution
 * shape regardless of whether a filter is active.
 *
 * Charges with no `customer_id` (raw PaymentIntents made without a customer
 * attached) are skipped — they can't be aggregated by customer. They DO
 * still count in the existing revenue tiles.
 */
export async function fetchTopCustomers(
  client: Client,
  stripeAccountId: string,
  productIds: string[],
  dateFrom: string,
  dateTo: string,
  limit = 10,
  tz: string = 'UTC',
): Promise<TopCustomerRow[]> {
  // We need the per-charge `customer_id` alongside the (filtered) amount.
  // `fetchAccountCharges` returns ChargeRow which intentionally hides
  // customer_id (it's bucket-by-day-only). Re-implement the two paths
  // narrowly here with `customer_id` included.
  //
  // tz-aware bounds: see comment in `fetchAccountCharges`.
  const fromISO = localMidnightUtc(dateFrom, tz).toISOString()
  const toExclusiveISO = localMidnightUtc(addOneDay(dateTo), tz).toISOString()

  const sumByCustomer = new Map<string, number>()

  if (productIds.length === 0) {
    const { data, error } = await client
      .from('stripe_charges')
      .select('amount, customer_id')
      .eq('stripe_account_id', stripeAccountId)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)

    if (error) throw new Error(`stripe_charges read (top customers): ${error.message}`)

    for (const r of data ?? []) {
      const cid = r.customer_id as string | null
      if (!cid) continue
      sumByCustomer.set(cid, (sumByCustomer.get(cid) ?? 0) + Number(r.amount))
    }
  } else {
    // Same shape as `fetchAccountCharges`'s filter path: sum line-item
    // amounts per charge, then look up parent charge for date + customer.
    const { data: liRows, error: liErr } = await client
      .from('stripe_line_items')
      .select('charge_id, amount')
      .eq('stripe_account_id', stripeAccountId)
      .in('product_id', productIds)
    if (liErr) throw new Error(`stripe_line_items read (top customers): ${liErr.message}`)
    if (!liRows || liRows.length === 0) return []

    const sumByCharge = new Map<string, number>()
    for (const li of liRows) {
      const cid = li.charge_id as string
      sumByCharge.set(cid, (sumByCharge.get(cid) ?? 0) + Number(li.amount))
    }

    const chargeIds = Array.from(sumByCharge.keys())
    const { data: chargeRows, error: chargeErr } = await client
      .from('stripe_charges')
      .select('id, customer_id')
      .in('id', chargeIds)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)
    if (chargeErr) throw new Error(`stripe_charges read (top customers, filtered): ${chargeErr.message}`)

    for (const r of chargeRows ?? []) {
      const cid = r.customer_id as string | null
      if (!cid) continue
      const amount = sumByCharge.get(r.id as string) ?? 0
      sumByCustomer.set(cid, (sumByCustomer.get(cid) ?? 0) + amount)
    }
  }

  if (sumByCustomer.size === 0) return []

  // Top N by amount.
  const ranked = Array.from(sumByCustomer.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)

  // Resolve names/emails/location in a single round trip.
  const ids = ranked.map(([cid]) => cid)
  const { data: custRows, error: custErr } = await client
    .from('stripe_customers')
    .select('id, name, email, address_country, address_city')
    .in('id', ids)
  if (custErr) throw new Error(`stripe_customers read: ${custErr.message}`)

  interface CustomerMeta {
    name: string | null
    email: string | null
    addressCountry: string | null
    addressCity: string | null
  }
  const byId = new Map<string, CustomerMeta>()
  for (const c of custRows ?? []) {
    byId.set(c.id as string, {
      name: (c.name as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      addressCountry: (c.address_country as string | null) ?? null,
      addressCity: (c.address_city as string | null) ?? null,
    })
  }

  return ranked.map(([customerId, amountCents]) => {
    const meta = byId.get(customerId)
    return {
      customerId,
      name: meta?.name ?? null,
      email: meta?.email ?? null,
      addressCountry: meta?.addressCountry ?? null,
      addressCity: meta?.addressCity ?? null,
      amountCents,
    }
  })
}

export interface ChurnRateResult {
  /** Decimal in [0, 1]. Caller formats as percent. */
  churnRate: number
  canceled30d: number
  activeNow: number
}

/**
 * Approximate 30-day churn rate. Defined as
 *
 *   canceled_in_last_30d / (active_now + canceled_in_last_30d)
 *
 * which trades exactness for simplicity — a real cohort churn would need
 * point-in-time historical state we don't yet capture. Good enough for a
 * dashboard tile; an honest follow-up belongs in its own change.
 *
 * Returns 0 when there are no relevant subs (so the tile renders "0.0%"
 * instead of NaN).
 *
 * v1 limitation: ignores the per-connection product filter. Subscription
 * churn under a product filter has a tricky definition ("did this customer
 * churn from Product A specifically, or just the account?") and isn't
 * worth designing without real user signal.
 */
export async function fetchChurnRate30d(
  client: Client,
  stripeAccountId: string,
): Promise<ChurnRateResult> {
  const thirtyDaysAgoISO = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const [activeRes, canceledRes] = await Promise.all([
    client
      .from('stripe_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('stripe_account_id', stripeAccountId)
      .in('status', ACTIVE_STATUSES as unknown as string[]),
    client
      .from('stripe_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('stripe_account_id', stripeAccountId)
      .gte('canceled_at', thirtyDaysAgoISO),
  ])

  if (activeRes.error) throw new Error(`stripe_subscriptions count active: ${activeRes.error.message}`)
  if (canceledRes.error) throw new Error(`stripe_subscriptions count canceled: ${canceledRes.error.message}`)

  const activeNow = activeRes.count ?? 0
  const canceled30d = canceledRes.count ?? 0
  const denom = activeNow + canceled30d
  const churnRate = denom === 0 ? 0 : canceled30d / denom

  return { churnRate, canceled30d, activeNow }
}
