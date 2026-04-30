import type {
  StripeSubscriptionItemRow,
  StripeSubscriptionRow,
} from './types'

/**
 * Convert a price's billing period to a fraction of one month.
 *
 * Same convention every billing-analytics tool uses (Baremetrics, ChartMogul,
 * Stripe Sigma): use the average month length in days. Trade-off is that
 * weekly and daily plans contribute a non-integer monthly value, but it's
 * the only consistent way to compare a $1/day plan against a $30/month plan.
 *
 * MULTIPLIER[interval] = "how many of this interval fit into one month"
 *   - day:   30.437  (avg days per month, 365.25 / 12)
 *   - week:  4.345   (avg weeks per month)
 *   - month: 1
 *   - year:  1/12
 */
const MONTHS_PER_INTERVAL: Record<'day' | 'week' | 'month' | 'year', number> = {
  day: 1 / 30.437,
  week: 1 / 4.345,
  month: 1,
  year: 12,
}

/**
 * Monthly MRR contribution of a single subscription, in cents.
 *
 * Walks `items.data[]`, computes `unit_amount * quantity / interval_in_months`
 * for each, and sums. Returns 0 for non-recurring or shape-broken subs (e.g. a
 * sub stuck in `incomplete` with no items expanded yet) — the caller filters
 * those out with `WHERE status IN ('active', 'trialing')` anyway.
 *
 * Rounded with `Math.round` rather than `Math.floor`: a $19.99/year plan
 * contributes 1.6658 cents/month — rounding matters more than truncation does.
 *
 * Pure function. No I/O. Unit-testable.
 */
export function computeMonthlyAmountCents(sub: StripeSubscriptionRow): number {
  const items = sub.items?.data ?? []
  let total = 0

  for (const item of items) {
    total += monthlyContributionCents(item)
  }

  return Math.round(total)
}

function monthlyContributionCents(item: StripeSubscriptionItemRow): number {
  const price = item.price
  if (!price?.recurring) return 0
  if (typeof price.unit_amount !== 'number') return 0

  const intervalCount = price.recurring.interval_count || 1
  const monthsPerCycle =
    MONTHS_PER_INTERVAL[price.recurring.interval] / intervalCount
  if (!monthsPerCycle) return 0

  const quantity = item.quantity ?? 1
  // unit_amount is per cycle. monthly = unit_amount * qty / cycle-length-in-months.
  return (price.unit_amount * quantity) / monthsPerCycle
}

/**
 * Project the subscription's items into the JSONB shape we persist on
 * `stripe_subscriptions.items`. Keeping this denormalised lets the per-product
 * filter on MRR / active-subs read straight from JSONB without joining a
 * second table — and keeps a future "MRR by product" tile a one-query change.
 */
export interface PersistedSubItem {
  product_id: string | null
  price_id: string | null
  quantity: number
  unit_amount: number | null
  currency: string | null
  interval: string | null
  interval_count: number | null
}

export function subscriptionItemsForRow(
  sub: StripeSubscriptionRow,
): PersistedSubItem[] {
  const items = sub.items?.data ?? []
  return items.map(item => ({
    product_id: item.price?.product ?? null,
    price_id: item.price?.id ?? null,
    quantity: item.quantity ?? 1,
    unit_amount: item.price?.unit_amount ?? null,
    currency: item.price?.currency ?? null,
    interval: item.price?.recurring?.interval ?? null,
    interval_count: item.price?.recurring?.interval_count ?? null,
  }))
}

/**
 * True iff the subscription has at least one item touching one of `productIds`.
 * Used to filter MRR / active-subs by the per-connection product filter.
 *
 * Empty `productIds` is the "all products" sentinel — callers should short-circuit
 * BEFORE calling this (no JSONB walk needed). We still return `true` here as a
 * safety net so a forgotten short-circuit doesn't silently drop every sub.
 */
export function subItemsTouchProducts(
  items: PersistedSubItem[],
  productIds: string[],
): boolean {
  if (productIds.length === 0) return true
  const wanted = new Set(productIds)
  for (const item of items) {
    if (item.product_id && wanted.has(item.product_id)) return true
  }
  return false
}
