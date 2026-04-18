import { fetchChargesSince } from '../stripe-api.helpers'
import type { StripeGetter, ChartPoint } from '../stripe-api.helpers'

/**
 * stripe_gross_today
 * Builds an hourly chart of Stripe charges from midnight UTC to now.
 * Returns an array of { label: "1am", value: cents } points.
 */
export async function computeGrossToday(get: StripeGetter): Promise<ChartPoint[]> {
  const now = new Date()
  const todayUnix = Math.floor(new Date(now).setUTCHours(0, 0, 0, 0) / 1000)
  const currentHour = new Date().getUTCHours()

  const charges = await fetchChargesSince(get, todayUnix)

  const buckets: number[] = new Array(currentHour + 1).fill(0)
  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const hour = new Date(c.created * 1000).getUTCHours()
    if (hour <= currentHour) buckets[hour] += c.amount
  }

  const fmtHour = (h: number) => {
    if (h === 0) return '12am'
    if (h < 12) return `${h}am`
    if (h === 12) return '12pm'
    return `${h - 12}pm`
  }

  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}
