import { sumCharges } from '../stripe-api.helpers'
import type { StripeGetter } from '../stripe-api.helpers'

/**
 * stripe_revenue_today
 * Fetches the total revenue from Stripe Charges API since midnight UTC.
 * Returns a string value in cents.
 */
export async function computeRevenueToday(get: StripeGetter): Promise<string> {
  const todayUnix = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000)
  return sumCharges(get, todayUnix)
}
