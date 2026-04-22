import { fetchChargesSince } from '../stripe-api.helpers'
import type { StripeGetter, ChartPoint } from '../stripe-api.helpers'

const fmtHour = (h: number) => {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

/**
 * Hourly chart of Stripe charges for a single UTC day.
 * When `dateStr` is today, buckets stop at the current hour (same as the old stripe_gross_today behaviour);
 * for past days, all 24 hours are returned.
 */
export async function computeHourlyGross(get: StripeGetter, dateStr?: string): Promise<ChartPoint[]> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayUnix = Math.floor(todayStart.getTime() / 1000)

  let dayStart: number
  let isToday: boolean
  if (!dateStr) {
    dayStart = todayUnix
    isToday = true
  } else {
    dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000)
    isToday = dayStart === todayUnix
  }
  const dayEnd = dayStart + 86_400

  const charges = await fetchChargesSince(get, dayStart, dayEnd)

  const hoursInBucket = isToday ? new Date().getUTCHours() + 1 : 24
  const buckets: number[] = new Array(hoursInBucket).fill(0)

  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const hour = new Date(c.created * 1000).getUTCHours()
    if (hour < hoursInBucket) buckets[hour] += c.amount
  }

  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}

/**
 * stripe_gross_today — back-compat wrapper: hourly chart for today in UTC.
 */
export async function computeGrossToday(get: StripeGetter): Promise<ChartPoint[]> {
  return computeHourlyGross(get)
}
