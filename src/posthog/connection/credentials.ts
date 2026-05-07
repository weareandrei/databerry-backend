import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

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
  supabaseService: SupabaseService,
): Promise<PosthogCredentials | null> {
  // Pull `user_id` via FK join so we can derive the per-user
  // decryption key — see `common/crypto/encryption.ts` for rationale.
  // Some callers (scheduler, lifecycle hooks) don't have a `userId`
  // in scope, so the join is the only source.
  const { data: ph, error } = await supabaseService
    .getClient()
    .from('connections_posthog')
    .select('api_key, project_id, host, connections!inner(user_id)')
    .eq('connection_id', connectionId)
    .single()

  if (error || !ph) return null

  const userId = (
    Array.isArray(ph.connections) ? ph.connections[0] : ph.connections
  )?.user_id as string | undefined
  if (!userId) return null  // orphaned creds — treat as missing

  // Decrypt-on-read with plaintext fallback for pre-migration rows.
  const apiKeyRaw = ph.api_key as string
  const apiKey = isEncrypted(apiKeyRaw) ? decryptForUser(apiKeyRaw, userId) : apiKeyRaw

  return {
    apiKey,
    projectId: ph.project_id as string,
    host: (ph.host as string) ?? 'https://app.posthog.com',
  }
}

@Injectable()
export class PosthogCredentialsService {
  private readonly logger = new Logger(PosthogCredentialsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async getEventDefinitions(
    connectionId: string,
    userId: string,
  ): Promise<PosthogEventDefinition[]> {
    this.logger.log(
      `\n  ► getEventDefinitions\n  connectionId : ${connectionId}\n  userId       : ${userId}`,
    )

    const { data: conn, error: connErr } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()

    if (connErr || !conn) {
      this.logger.warn(`  ✗ Connection not found\n  connectionId : ${connectionId}`)
      throw new NotFoundException('Connection not found')
    }

    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
    if (!ph) throw new NotFoundException('PostHog config not found')

    const url = `${ph.host}/api/projects/${ph.projectId}/event_definitions/?limit=200`

    this.logger.log(
      `  → calling PostHog\n  host      : ${ph.host}\n  projectId : ${ph.projectId}`,
    )

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ph.apiKey}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.logger.error(`  ✗ PostHog API responded ${res.status}\n  body : ${JSON.stringify(body)}`)
      throw new Error(`PostHog API error ${res.status}: ${JSON.stringify(body)}`)
    }

    const json = (await res.json()) as { results: PosthogEventDefinition[] }
    this.logger.log(`  ✓ received ${json.results.length} event definitions`)

    // Fetch recent events to compute 30d volume and extract last URL
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const eventsUrl = `${ph.host}/api/projects/${ph.projectId}/events/?limit=1000&after=${thirtyDaysAgo}`

    const eventStats: Map<string, { count: number; lastUrl: string | null }> = new Map()

    try {
      const eventsRes = await fetch(eventsUrl, {
        headers: { Authorization: `Bearer ${ph.apiKey}` },
      })
      if (eventsRes.ok) {
        const eventsJson = (await eventsRes.json()) as {
          results: Array<{ event: string; properties: Record<string, unknown> }>
        }
        for (const ev of eventsJson.results) {
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
        this.logger.log(`  ✓ fetched ${eventsJson.results.length} recent events for stats`)
      }
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
