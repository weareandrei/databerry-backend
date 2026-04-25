import type { SupabaseService } from '../../supabase/supabase.service'

type Client = ReturnType<SupabaseService['getClient']>

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
 */
export async function getConnectionProductFilter(
  client: Client,
  connectionId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from('connection_stripe_products')
    .select('product_id')
    .eq('connection_id', connectionId)

  if (error) throw new Error(`connection_stripe_products read: ${error.message}`)
  return (data ?? []).map(r => r.product_id as string)
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
): Promise<ChargeRow[]> {
  const fromISO = `${dateFrom}T00:00:00Z`
  const toExclusiveISO = nextDayISO(dateTo)

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

function nextDayISO(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}
