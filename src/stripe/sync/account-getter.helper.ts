import type { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetter, type StripeGetter } from '../views/stripe-api.helpers'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * Pull `user_id` from the joined `connections` row regardless of
 * whether PostgREST inferred a one-to-one (object) or a many-to-one
 * (array) embed shape. Returns undefined if the FK is dangling so
 * the caller can fall back to whichever path remains.
 */
function joinedUserId(row: { connections?: unknown } | null | undefined): string | undefined {
  const conn = row?.connections
  if (!conn) return undefined
  const obj = Array.isArray(conn) ? conn[0] : conn
  return (obj as { user_id?: string } | undefined)?.user_id
}

/**
 * Build a StripeGetter authenticated for a given Stripe account, regardless of
 * whether the account is connected via Stripe Connect (OAuth) or via direct
 * API key. Resolves credentials by looking up any connection that points at
 * the account — preferred order is manual (cheaper, no header round-trip)
 * then OAuth.
 *
 * Both branches now also pull the parent `connections.user_id` so the
 * stored credential can be decrypted with the per-user envelope. The
 * scheduler / nightly reconcile have no `userId` in their own scope —
 * the join is the only place to recover it.
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
    .select('api_key, connections!inner(user_id)')
    .eq('stripe_account_id', stripeAccountId)
    .limit(1)
    .maybeSingle()

  if (manual?.api_key) {
    const userId = joinedUserId(manual)
    if (!userId) throw new Error(`Stripe manual creds orphaned (no user_id) for account ${stripeAccountId}`)
    const raw = manual.api_key as string
    const apiKey = isEncrypted(raw) ? decryptForUser(raw, userId) : raw
    return makeStripeGetter(apiKey)
  }

  // Stripe Connect — use the stored access token. Connect access tokens are
  // restricted-key-equivalents tied to the linked account, so a plain Bearer
  // suffices (no Stripe-Account header needed when using the access token).
  const { data: connect } = await client
    .from('connections_stripe')
    .select('access_token, connections!inner(user_id)')
    .eq('stripe_account_id', stripeAccountId)
    .limit(1)
    .maybeSingle()

  if (connect?.access_token) {
    const userId = joinedUserId(connect)
    if (!userId) throw new Error(`Stripe Connect creds orphaned (no user_id) for account ${stripeAccountId}`)
    const raw = connect.access_token as string
    const accessToken = isEncrypted(raw) ? decryptForUser(raw, userId) : raw
    return makeStripeGetter(accessToken)
  }

  throw new Error(`No Stripe credentials found for account ${stripeAccountId}`)
}
