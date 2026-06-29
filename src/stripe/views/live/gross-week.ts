import { fetchChargesSince } from '../../stripe-api.client'
import type { StripeApiClient } from '../../stripe-api.client'
import type { ChartPoint } from '../stripe-api.helpers'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Daily chart of Stripe charges across a date range [dateFrom, dateTo] (inclusive, UTC days).
 * Used for Weekly and Monthly modes.
 */
export async function computeDailyGross(
  client: StripeApiClient,
  dateFrom: string,
  dateTo: string,
): Promise<ChartPoint[]> {
  const start = new Date(dateFrom + 'T00:00:00Z')
  const end = new Date(dateTo + 'T00:00:00Z')
  const startUnix = Math.floor(start.getTime() / 1000)
  const endUnixExclusive = Math.floor(end.getTime() / 1000) + 86_400

  const numDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const charges = await fetchChargesSince(client, startUnix, endUnixExclusive)

  const buckets: number[] = new Array(numDays).fill(0)
  for (const c of charges) {
    if (c.status !== 'succeeded') continue
    const chargeDate = new Date(c.created * 1000)
    const dayIndex = Math.floor(
      (Date.UTC(chargeDate.getUTCFullYear(), chargeDate.getUTCMonth(), chargeDate.getUTCDate()) -
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) /
        (1000 * 60 * 60 * 24),
    )
    if (dayIndex >= 0 && dayIndex < numDays) buckets[dayIndex] += c.amount
  }

  return buckets.map((value, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return { label: DAY_LABELS[d.getUTCDay()], value }
  })
}

/**
 * stripe_gross_week — back-compat wrapper: daily chart from this week's Monday to today (UTC).
 */
export async function computeGrossWeek(client: StripeApiClient): Promise<ChartPoint[]> {
  const now = new Date()
  const day = now.getUTCDay()
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday)
  monday.setUTCHours(0, 0, 0, 0)

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

  return computeDailyGross(client, fmt(monday), fmt(today))
}
