import type { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetter, type StripeGetter } from '../views/stripe-api.helpers'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * Build a StripeGetter authenticated for a given Stripe account, regardless of
 * whether the account is connected via Stripe Connect (OAuth) or via direct
 * API key. Resolves credentials by looking up any connection that points at
 * the account — preferred order is manual (cheaper, no header round-trip)
 * then OAuth.
 *
 * Throws if no credentials can be found for the account.
 */
export async function makeStripeGetterForAccount(
  client: Client,
  stripeAccountId: string,
): Promise<StripeGetter> {
  // Manual API key — preferred. The key acts directly on the linked account.
  const { data: manual } = await client
    .from('connections_stripe_manual')
    .select('api_key')
    .eq('stripe_account_id', stripeAccountId)
    .limit(1)
    .maybeSingle()

  if (manual?.api_key) {
    return makeStripeGetter(manual.api_key as string)
  }

  // Stripe Connect — use the stored access token. Connect access tokens are
  // restricted-key-equivalents tied to the linked account, so a plain Bearer
  // suffices (no Stripe-Account header needed when using the access token).
  const { data: connect } = await client
    .from('connections_stripe')
    .select('access_token')
    .eq('stripe_account_id', stripeAccountId)
    .limit(1)
    .maybeSingle()

  if (connect?.access_token) {
    return makeStripeGetter(connect.access_token as string)
  }

  throw new Error(`No Stripe credentials found for account ${stripeAccountId}`)
}
