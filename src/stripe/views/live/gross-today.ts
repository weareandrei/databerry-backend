import { fetchChargesSince } from '../../stripe-api.client'
import type { StripeApiClient } from '../../stripe-api.client'
import type { ChartPoint } from '../stripe-api.helpers'
import { dateStrInTz, hourInTz, hourlyBucketCount } from '../../../common/tz'

const fmtHour = (h: number) => {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

/**
 * Hourly chart of Stripe charges for a single calendar day in `tz`.
 * When `dateStr` is the user's "today" (in `tz`), buckets stop at the
 * current local hour — for past days, all 24 hours render.
 *
 * Both the bucket assignment and the truncation key off `tz` so a user
 * in any zone sees a chart that matches their wall clock; the earlier
 * UTC-only implementation silently dropped events from the late-evening
 * hours for any +N user once UTC crossed midnight.
 *
 * NOTE: this module is currently dead code (no production caller). The
 * fix is mirrored here for consistency with the live `bucketByHour` in
 * `views.service.ts` so future callers don't re-introduce the same UTC
 * truncation bug by copy-pasting.
 */
export async function computeHourlyGross(
  client: StripeApiClient,
  dateStr?: string,
  tz: string = 'UTC',
): Promise<ChartPoint[]> {
  const now = new Date()
  const todayStr = dateStrInTz(now, tz)
  const resolvedDateStr = dateStr ?? todayStr
  const dayStart = Math.floor(new Date(resolvedDateStr + 'T00:00:00Z').getTime() / 1000)
  const dayEnd = dayStart + 86_400
  const isToday = resolvedDateStr === todayStr

  const charges = await fetchChargesSince(client, dayStart, dayEnd)

  const hoursInBucket = isToday ? hourlyBucketCount(resolvedDateStr, tz, now) : 24
  const buckets: number[] = new Array(hoursInBucket).fill(0)

  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const hour = hourInTz(new Date(c.created * 1000), tz)
    if (hour < hoursInBucket) buckets[hour] += c.amount
  }

  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}

/**
 * stripe_gross_today — back-compat wrapper: hourly chart for today in `tz`.
 */
export async function computeGrossToday(
  client: StripeApiClient,
  tz: string = 'UTC',
): Promise<ChartPoint[]> {
  return computeHourlyGross(client, undefined, tz)
}
