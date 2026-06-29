import type { StripeRepository } from '../../stripe.repository'
import {
  fetchAccountCharges,
  type ChargeRow,
} from '../storage-queries'

import type { BucketGranularity } from '../../../common/types'
export type { BucketGranularity }

/**
 * Revenue (succeeded charges, in cents) for a Stripe account, grouped by
 * hourly or daily UTC bucket.
 *
 * Source of truth is Supabase (`stripe_charges` + optionally `stripe_line_items`).
 * Callers pass `productIds` to scope to a subset of products — empty array
 * means "all products" (default).
 *
 * Returns unix-second keys so callers can map into their bucket grid.
 */
export async function fetchStripeRevenueByBucketFromStorage(
  stripeRepo: StripeRepository,
  stripeAccountId: string,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  productIds: string[] = [],
): Promise<{ bucketUnix: number; value: number }[]> {
  const rows = await fetchAccountCharges(
    stripeRepo,
    stripeAccountId,
    dateFrom,
    dateTo,
    productIds,
  )
  return bucketRows(rows, granularity)
}

function bucketRows(
  rows: ChargeRow[],
  granularity: BucketGranularity,
): { bucketUnix: number; value: number }[] {
  const map = new Map<number, number>()
  for (const r of rows) {
    const d = new Date(r.created)
    if (granularity === 'hourly') {
      d.setUTCMinutes(0, 0, 0)
    } else {
      d.setUTCHours(0, 0, 0, 0)
    }
    const key = Math.floor(d.getTime() / 1000)
    map.set(key, (map.get(key) ?? 0) + r.amount)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketUnix, value]) => ({ bucketUnix, value }))
}
