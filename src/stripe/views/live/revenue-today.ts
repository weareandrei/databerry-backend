import { sumCharges } from '../stripe-api.helpers'
import type { StripeGetter } from '../stripe-api.helpers'

/**
 * stripe_revenue_today
 * Fetches the total revenue from Stripe Charges API for a specific date (defaults to today).
 * Returns a string value in cents.
 */
export async function computeRevenueToday(get: StripeGetter, date?: string): Promise<string> {
  const dayStart = date
    ? Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
    : Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000)
  const dayEnd = dayStart + 86_400
  return sumCharges(get, dayStart, dayEnd)
}
