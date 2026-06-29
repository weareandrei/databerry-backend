import type { ConnectionsRepository } from '../../connections/connections.repository'
import { StripeApiClient } from '../stripe-api.client'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

function joinedUserId(row: { connections?: unknown } | null | undefined): string | undefined {
  const connection = row?.connections
  if (!connection) return undefined
  const object = Array.isArray(connection) ? connection[0] : connection
  return (object as { user_id?: string } | undefined)?.user_id
}

/**
 * Build a StripeApiClient for a Stripe account id (manual key or Connect token).
 * One client instance per resolved credential — not a singleton.
 */
export async function createStripeApiClientForAccount(
  connectionsRepository: ConnectionsRepository,
  stripeAccountId: string,
): Promise<StripeApiClient> {
  const { data: manualCredentials } =
    await connectionsRepository.getManualCredentialByAccount(stripeAccountId)

  if (manualCredentials?.api_key) {
    const userId = joinedUserId(manualCredentials)
    if (!userId) {
      throw new Error(`Stripe manual creds orphaned (no user_id) for account ${stripeAccountId}`)
    }
    const apiKey = manualCredentials.api_key as string
    const decrypted = isEncrypted(apiKey) ? decryptForUser(apiKey, userId) : apiKey
    return new StripeApiClient(decrypted)
  }

  const { data: connectCredentials } =
    await connectionsRepository.getOAuthCredentialByAccount(stripeAccountId)

  if (connectCredentials?.access_token) {
    const userId = joinedUserId(connectCredentials)
    if (!userId) {
      throw new Error(`Stripe Connect creds orphaned (no user_id) for account ${stripeAccountId}`)
    }
    const accessToken = connectCredentials.access_token as string
    const decrypted = isEncrypted(accessToken) ? decryptForUser(accessToken, userId) : accessToken
    return new StripeApiClient(decrypted)
  }

  throw new Error(`No Stripe credentials found for account ${stripeAccountId}`)
}
