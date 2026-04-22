import { fetchChargesSince } from '../stripe-api.helpers'
import type { StripeGetter } from '../stripe-api.helpers'

export type BucketGranularity = 'hourly' | 'daily'

/**
 * Revenue (succeeded charges, in cents) grouped by hourly or daily bucket.
 * Returns unix-second keys so callers can map into their bucket grid.
 */
export async function fetchStripeRevenueByBucket(
  get: StripeGetter,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
): Promise<{ bucketUnix: number; value: number }[]> {
  const start = new Date(dateFrom + 'T00:00:00Z')
  const endExclusive = new Date(dateTo + 'T00:00:00Z')
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)

  const startUnix = Math.floor(start.getTime() / 1000)
  const endUnix = Math.floor(endExclusive.getTime() / 1000)

  const charges = await fetchChargesSince(get, startUnix, endUnix)

  const map = new Map<number, number>()
  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const d = new Date(c.created * 1000)
    if (granularity === 'hourly') {
      d.setUTCMinutes(0, 0, 0)
    } else {
      d.setUTCHours(0, 0, 0, 0)
    }
    const key = Math.floor(d.getTime() / 1000)
    map.set(key, (map.get(key) ?? 0) + c.amount)
  }

  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketUnix, value]) => ({ bucketUnix, value }))
}
