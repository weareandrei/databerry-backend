import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { getPosthogCredentials } from '../connection/credentials'

@Injectable()
export class PosthogLifecycleService {
  private readonly logger = new Logger(PosthogLifecycleService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

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

    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
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
      inputs_schema: [{ key: 'url', type: 'string', label: 'Webhook URL', required: true }],
      inputs: { url: { value: webhookUrl } },
      filters: { events: [{ id: eventName, name: eventName, type: 'events' }] },
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

    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
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
}
