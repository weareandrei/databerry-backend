import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConnectionsRepository } from '../../connections/connections.repository'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'
import { PosthogApiClient } from '../posthog-api.client'
import { PosthogRepository } from './posthog.repository'

export interface PosthogEventDefinition {
  id: string
  name: string
  volume_30_day: number | null
  computed_volume: number
  last_seen_at: string | null
  last_url: string | null
}

export interface PosthogCredentials {
  apiKey: string
  projectId: string
  host: string
}

/** Standalone helper — importable by both PosthogCredentialsService and PosthogLifecycleService. */
export async function getPosthogCredentials(
  connectionId: string,
  credentialsService: PosthogCredentialsService,
): Promise<PosthogCredentials | null> {
  return credentialsService.getCredentials(connectionId)
}

@Injectable()
export class PosthogCredentialsService {
  private readonly logger = new Logger(PosthogCredentialsService.name)

  constructor(
    private readonly posthogRepository: PosthogRepository,
    private readonly connectionsRepository: ConnectionsRepository,
  ) {}

  async getCredentials(connectionId: string): Promise<PosthogCredentials | null> {
    const { data: ph, error } =
      await this.posthogRepository.findByConnectionIdWithUser(connectionId)

    if (error || !ph) return null

    const userId = (
      Array.isArray(ph.connections) ? ph.connections[0] : ph.connections
    )?.user_id as string | undefined
    if (!userId) return null

    const apiKeyRaw = ph.api_key as string
    const apiKey = isEncrypted(apiKeyRaw) ? decryptForUser(apiKeyRaw, userId) : apiKeyRaw

    return {
      apiKey,
      projectId: ph.project_id as string,
      host: (ph.host as string) ?? 'https://app.posthog.com',
    }
  }

  async getEventDefinitions(
    connectionId: string,
    userId: string,
  ): Promise<PosthogEventDefinition[]> {
    this.logger.log(
      `\n  ► getEventDefinitions\n  connectionId : ${connectionId}\n  userId       : ${userId}`,
    )

    const { data: conn, error: connErr } =
      await this.connectionsRepository.findIdByConnectionAndUser(connectionId, userId)

    if (connErr || !conn) {
      this.logger.warn(`  ✗ Connection not found\n  connectionId : ${connectionId}`)
      throw new NotFoundException('Connection not found')
    }

    const ph = await this.getCredentials(connectionId)
    if (!ph) throw new NotFoundException('PostHog config not found')

    const client = new PosthogApiClient(ph)

    this.logger.log(
      `  → calling PostHog\n  host      : ${ph.host}\n  projectId : ${ph.projectId}`,
    )

    let json: { results: PosthogEventDefinition[] }
    try {
      json = (await client.getEventDefinitions()) as { results: PosthogEventDefinition[] }
    } catch (err) {
      this.logger.error(`  ✗ PostHog API responded\n  body : ${String(err)}`)
      throw err
    }
    this.logger.log(`  ✓ received ${json.results.length} event definitions`)

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const eventStats: Map<string, { count: number; lastUrl: string | null }> = new Map()

    try {
      const eventsJson = await client.getEvents({ limit: 1000, after: thirtyDaysAgo })
      for (const ev of eventsJson.results ?? []) {
        const existing = eventStats.get(ev.event)
        if (!existing) {
          eventStats.set(ev.event, {
            count: 1,
            lastUrl: (ev.properties['$current_url'] as string | undefined) ?? null,
          })
        } else {
          existing.count++
        }
      }
      this.logger.log(`  ✓ fetched ${eventsJson.results?.length ?? 0} recent events for stats`)
    } catch (e) {
      this.logger.warn(`  ⚠ events stats fetch failed — computed_volume will be 0\n  ${e}`)
    }

    return json.results.map(def => ({
      ...def,
      computed_volume: eventStats.get(def.name)?.count ?? 0,
      last_url: eventStats.get(def.name)?.lastUrl ?? null,
    }))
  }
}
