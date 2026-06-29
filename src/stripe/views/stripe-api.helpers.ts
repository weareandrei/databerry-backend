import { NotFoundException } from '@nestjs/common'
import type { ConnectionsRepository } from '../../connections/connections.repository'
import { ConnectionMissingException } from '../../common/integration-errors'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

export interface ChartPoint {
  label: string
  value: number // cents
}

/** Retrieves the Stripe manual API key for a connection, verifying ownership. */
export async function getApiKey(
  connectionId: string,
  userId: string,
  connectionsRepository: ConnectionsRepository,
): Promise<string> {
  const { data: connection } = await connectionsRepository.findIdByConnectionAndUser(
    connectionId,
    userId,
  )

  if (!connection) throw new ConnectionMissingException('stripe_manual', connectionId)

  const { data: manualCredentials } =
    await connectionsRepository.getManualApiKey(connectionId)

  if (!manualCredentials) throw new NotFoundException('Stripe manual credentials not found')

  const apiKey = manualCredentials.api_key as string
  return isEncrypted(apiKey) ? decryptForUser(apiKey, userId) : apiKey
}

/** Manual API key lookup without user ownership check (scheduler / internal). */
export async function getApiKeyInternal(
  connectionId: string,
  connectionsRepository: ConnectionsRepository,
): Promise<string> {
  const { data: manualCredentials } =
    await connectionsRepository.getManualApiKeyWithUserId(connectionId)

  if (!manualCredentials) throw new Error('Stripe manual credentials not found')

  const userId = (
    Array.isArray(manualCredentials.connections)
      ? manualCredentials.connections[0]
      : manualCredentials.connections
  )?.user_id as string | undefined
  if (!userId) {
    throw new Error('Stripe manual credentials orphaned (no user_id)')
  }

  const apiKey = manualCredentials.api_key as string
  return isEncrypted(apiKey) ? decryptForUser(apiKey, userId) : apiKey
}
