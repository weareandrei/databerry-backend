import { fetchChargesSince } from '../stripe-api.helpers'
import type { StripeGetter, ChartPoint } from '../stripe-api.helpers'

/**
 * stripe_gross_week
 * Builds a daily chart of Stripe charges from Monday to today.
 * Returns an array of { label: "Mon", value: cents } points.
 */
export async function computeGrossWeek(get: StripeGetter): Promise<ChartPoint[]> {
  const now = new Date()
  const day = now.getUTCDay()
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday)
  monday.setUTCHours(0, 0, 0, 0)
  const mondayUnix = Math.floor(monday.getTime() / 1000)

  const charges = await fetchChargesSince(get, mondayUnix)

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const numDays = daysSinceMonday + 1
  const buckets: number[] = new Array(numDays).fill(0)

  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const chargeDate = new Date(c.created * 1000)
    const dayIndex = Math.floor(
      (chargeDate.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24),
    )
    if (dayIndex >= 0 && dayIndex < numDays) buckets[dayIndex] += c.amount
  }

  return buckets.map((value, i) => {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    return { label: DAY_LABELS[d.getUTCDay()], value }
  })
}
