import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { getPosthogCredentials } from '../connection/credentials'

@Injectable()
export class PosthogViewsService {
  private readonly logger = new Logger(PosthogViewsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async fetchLiveValue(connectionId: string, viewId: string, userId: string): Promise<string> {
    this.logger.log(
      `\n  ► fetchLiveValue (posthog)\n  connectionId : ${connectionId}\n  viewId       : ${viewId}`,
    )

    const client = this.supabaseService.getClient()

    // Verify connection ownership
    const { data: conn, error: connErr } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()

    if (connErr || !conn) throw new NotFoundException('Connection not found')

    // Fetch view config to get eventName
    const { data: view, error: viewErr } = await client
      .from('views')
      .select('config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()

    if (viewErr || !view) throw new NotFoundException('View not found')

    const config = (view.config ?? {}) as Record<string, unknown>
    const eventName = (config.eventName as string | undefined) ?? ''

    if (!eventName) {
      this.logger.warn(`  ⚠ No eventName in view config — returning 0`)
      return '0'
    }

    // Get PostHog credentials
    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
    if (!ph) throw new NotFoundException('PostHog credentials not found')

    // Query today's count via HogQL
    const safeEvent = eventName.replace(/'/g, "\\'")
    const hogqlQuery = `SELECT count() FROM events WHERE event = '${safeEvent}' AND toDate(timestamp) = today()`

    this.logger.log(`  → querying PostHog HogQL: ${hogqlQuery}`)

    const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ph.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogqlQuery } }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.logger.error(`  ✗ PostHog query API ${res.status}\n  body: ${JSON.stringify(body)}`)
      throw new Error(`PostHog query API error ${res.status}`)
    }

    const json = (await res.json()) as { results?: [[number]] }
    const count = json.results?.[0]?.[0] ?? 0
    const value = String(count)

    this.logger.log(`  ✓ today's count: ${value}`)

    // Upsert today's value; clear needs_sync since we just fetched the real count.
    // Insert-on-conflict is safe against concurrent calls (unique constraint on view_id+created_at).
    const today = new Date().toISOString().split('T')[0]
    const { error: insertErr } = await client
      .from('views_values')
      .insert({ view_id: viewId, value, created_at: today, needs_sync: false })

    if (insertErr?.code === '23505') {
      await client
        .from('views_values')
        .update({ value, updated_at: new Date().toISOString(), needs_sync: false })
        .eq('view_id', viewId)
        .eq('created_at', today)
    }

    return value
  }
}
