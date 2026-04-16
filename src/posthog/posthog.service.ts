import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export interface PosthogEventDefinition {
  id: string
  name: string
  volume_30_day: number | null
  computed_volume: number
  last_seen_at: string | null
  last_url: string | null
}

@Injectable()
export class PosthogService {
  private readonly logger = new Logger(PosthogService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  // ── Hog Functions (Destinations) ───────────────────────────────────────────

  async createHogFunction(
    connectionId: string,
    viewId: string,
    eventName: string,
  ): Promise<string | null> {
    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL

    if (!webhookBaseUrl) {
      this.logger.warn(`\n  ⚠ createHogFunction skipped\n  reason : WEBHOOK_BASE_URL not set`)
      return null
    }

    this.logger.log(
      `\n  ► createHogFunction\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  eventName    : ${eventName}`,
    )

    const ph = await this.getPosthogCredentials(connectionId)
    if (!ph) return null

    const webhookUrl = `${webhookBaseUrl}/webhooks/posthog/${connectionId}/${viewId}`

    const hogCode = `
let res := fetch(inputs.url, {
  'method': 'POST',
  'headers': {
    'Content-Type': 'application/json',
  },
  'body': jsonStringify({
    'event': event.event,
    'uuid': event.uuid,
    'timestamp': event.timestamp,
    'distinct_id': event.distinct_id,
    'properties': event.properties,
  })
});
if (res.status >= 400) {
  throw Error(f'Webhook failed: {res.status}')
}
`.trim()

    const payload = {
      type: 'destination',
      name: `Kontext: ${eventName}`,
      enabled: true,
      hog: hogCode,
      inputs_schema: [
        {
          key: 'url',
          type: 'string',
          label: 'Webhook URL',
          required: true,
        },
      ],
      inputs: {
        url: { value: webhookUrl },
      },
      filters: {
        events: [{ id: eventName, name: eventName, type: 'events' }],
      },
    }

    this.logger.log(
      `  → calling PostHog\n  host      : ${ph.host}\n  projectId : ${ph.projectId}\n  url       : ${webhookUrl}`,
    )

    const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/hog_functions/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ph.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.logger.error(
        `  ✗ PostHog rejected hog function ${res.status}\n  body : ${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}`,
      )
      throw new Error(`PostHog rejected hog function ${res.status}: ${JSON.stringify(body)}`)
    }

    const json = (await res.json()) as { id: string }
    this.logger.log(`  ✓ hog function created  id: ${json.id}`)
    return json.id
  }

  async deleteHogFunction(connectionId: string, hogFunctionId: string): Promise<void> {
    this.logger.log(
      `\n  ► deleteHogFunction\n  connectionId  : ${connectionId}\n  hogFunctionId : ${hogFunctionId}`,
    )

    const ph = await this.getPosthogCredentials(connectionId)
    if (!ph) return

    const res = await fetch(
      `${ph.host}/api/projects/${ph.projectId}/hog_functions/${hogFunctionId}/`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${ph.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deleted: true }),
      },
    )

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.logger.error(
        `  ✗ PostHog delete failed ${res.status}\n  body : ${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}`,
      )
      return
    }

    this.logger.log(`  ✓ hog function deleted`)
  }

  // ── Event Definitions ──────────────────────────────────────────────────────

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

    const ph = await this.getPosthogCredentials(connectionId)
    if (!ph) throw new NotFoundException('PostHog config not found')

    const url = `${ph.host}/api/projects/${ph.projectId}/event_definitions/?limit=200`

    this.logger.log(
      `  → calling PostHog\n  host      : ${ph.host}\n  projectId : ${ph.projectId}\n  url       : ${url}`,
    )

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ph.apiKey}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.logger.error(
        `  ✗ PostHog API responded ${res.status}\n  body : ${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}`,
      )
      throw new Error(`PostHog API error ${res.status}: ${JSON.stringify(body)}`)
    }

    const json = (await res.json()) as { results: PosthogEventDefinition[] }
    this.logger.log(`  ✓ received ${json.results.length} event definitions`)

    // ── Fetch recent events to compute 30d volume and extract last URL ────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const eventsUrl = `${ph.host}/api/projects/${ph.projectId}/events/?limit=1000&after=${thirtyDaysAgo}`

    let eventStats: Map<string, { count: number; lastUrl: string | null }> = new Map()

    try {
      const eventsRes = await fetch(eventsUrl, {
        headers: { Authorization: `Bearer ${ph.apiKey}` },
      })
      if (eventsRes.ok) {
        const eventsJson = (await eventsRes.json()) as {
          results: Array<{
            event: string
            properties: Record<string, unknown>
          }>
        }
        // Events are returned newest-first; first occurrence of each name = most recent
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

  // ── Private Helpers ────────────────────────────────────────────────────────

  private async getPosthogCredentials(connectionId: string): Promise<{
    apiKey: string
    projectId: string
    host: string
  } | null> {
    const { data: ph, error } = await this.supabaseService
      .getClient()
      .from('connections_posthog')
      .select('api_key, project_id, host')
      .eq('connection_id', connectionId)
      .single()

    if (error || !ph) {
      this.logger.error(
        `  ✗ PostHog config not found\n  connectionId : ${connectionId}\n  dbError      : ${error?.message}`,
      )
      return null
    }

    return {
      apiKey: ph.api_key as string,
      projectId: ph.project_id as string,
      host: (ph.host as string) ?? 'https://app.posthog.com',
    }
  }
}
