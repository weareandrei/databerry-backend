import { sumCharges } from '../../stripe-api.client'
import type { StripeApiClient } from '../../stripe-api.client'

function dayStartUnix(dateStr?: string): number {
  if (!dateStr) {
    return Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000)
  }
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000)
}

/**
 * Compute revenue for an arbitrary date range [dateFrom, dateTo] (inclusive on both ends).
 * When `dateTo` is not provided, the range is a single day (equivalent to `computeRevenueToday`).
 * Returns the total in cents as a string.
 */
export async function computeRevenueRange(
  client: StripeApiClient,
  dateFrom?: string,
  dateTo?: string,
): Promise<string> {
  const start = dayStartUnix(dateFrom)
  const endDay = dayStartUnix(dateTo ?? dateFrom)
  const end = endDay + 86_400 // exclusive upper bound — one day past the last included day
  return sumCharges(client, start, end)
}

/**
 * stripe_revenue_today
 * Back-compat wrapper that returns today's revenue (or a single specified day).
 */
export async function computeRevenueToday(client: StripeApiClient, date?: string): Promise<string> {
  return computeRevenueRange(client, date, date)
}
