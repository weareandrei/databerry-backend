import { Injectable, Logger } from '@nestjs/common'
import { PosthogApiClient } from '../posthog-api.client'
import { getPosthogCredentials, PosthogCredentialsService } from '../connection/credentials'

@Injectable()
export class PosthogLifecycleService {
  private readonly logger = new Logger(PosthogLifecycleService.name)

  constructor(private readonly posthogCredentialsService: PosthogCredentialsService) {}

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

    const ph = await getPosthogCredentials(connectionId, this.posthogCredentialsService)
    if (!ph) return null
    const client = new PosthogApiClient(ph)

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

    try {
      const json = await client.createHogFunction(payload)
      this.logger.log(`  ✓ hog function created  id: ${json.id}`)
      return json.id
    } catch (err) {
      this.logger.error(
        `  ✗ PostHog rejected hog function\n  body : ${String(err).replace(/\n/g, '\n  ')}`,
      )
      throw err
    }
  }

  async deleteHogFunction(connectionId: string, hogFunctionId: string): Promise<void> {
    this.logger.log(
      `\n  ► deleteHogFunction\n  connectionId  : ${connectionId}\n  hogFunctionId : ${hogFunctionId}`,
    )

    const ph = await getPosthogCredentials(connectionId, this.posthogCredentialsService)
    if (!ph) return
    const client = new PosthogApiClient(ph)

    try {
      await client.deleteHogFunction(hogFunctionId)
      this.logger.log(`  ✓ hog function deleted`)
    } catch (err) {
      this.logger.error(
        `  ✗ PostHog delete failed\n  body : ${String(err).replace(/\n/g, '\n  ')}`,
      )
    }
  }
}
