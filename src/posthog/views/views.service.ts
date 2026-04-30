import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ConnectionMissingException } from '../../common/integration-errors'
import { getPosthogCredentials, type PosthogCredentials } from '../connection/credentials'
import {
  fetchPosthogFunnel,
  type FunnelStepConfig,
  type FunnelStepRow,
} from './live/funnel'
import {
  fetchPosthogRetention,
  type RetentionConfig,
  type RetentionPeriod,
  type RetentionRow,
} from './live/retention'
import { fetchPosthogUsersList, type PosthogUserRow } from './live/users'

interface LoadedView {
  config: Record<string, unknown>
  ph: PosthogCredentials
}

@Injectable()
export class PosthogViewsService {
  private readonly logger = new Logger(PosthogViewsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Shared preamble: ownership check + view config + PostHog credentials.
   * Originally inlined in `fetchLiveValue`; pulled out so the new funnel /
   * retention / users methods don't repeat the same 4-DB-roundtrip dance.
   */
  private async loadViewAndCreds(
    connectionId: string,
    viewId: string,
    userId: string,
  ): Promise<LoadedView> {
    const client = this.supabaseService.getClient()

    const { data: conn, error: connErr } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()
    if (connErr || !conn) throw new ConnectionMissingException('posthog', connectionId)

    const { data: view, error: viewErr } = await client
      .from('views')
      .select('config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()
    if (viewErr || !view) throw new NotFoundException('View not found')

    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
    if (!ph) throw new NotFoundException('PostHog credentials not found')

    return { config: (view.config ?? {}) as Record<string, unknown>, ph }
  }

  async fetchLiveValue(
    connectionId: string,
    viewId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from
    const isSingleDay = from === to

    this.logger.log(
      `\n  ► fetchLiveValue (posthog)\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  dateFrom     : ${from}\n  dateTo       : ${to}`,
    )

    const client = this.supabaseService.getClient()
    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const eventName = (config.eventName as string | undefined) ?? ''

    if (!eventName) {
      this.logger.warn(`  ⚠ No eventName in view config — returning 0`)
      return { value: '0' }
    }

    const safeEvent = eventName.replace(/'/g, "\\'")
    const safeFrom = from.replace(/'/g, '')
    const safeTo = to.replace(/'/g, '')
    // Parens around BETWEEN are load-bearing — HogQL's AND binds tighter
    // than BETWEEN, so without them the parser reads
    // `(event = X AND toDate(timestamp)) BETWEEN …` and crashes on the
    // string-AND-Date type mismatch.
    const hogqlQuery = `SELECT count() FROM events WHERE event = '${safeEvent}' AND (toDate(timestamp) BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}'))`

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

    this.logger.log(`  ✓ range count: ${value}`)

    // Only persist to views_values for single-day queries (daily table).
    if (isSingleDay) {
      const { error: insertErr } = await client
        .from('views_values')
        .insert({ view_id: viewId, value, created_at: from, needs_sync: false })

      if (insertErr?.code === '23505') {
        await client
          .from('views_values')
          .update({ value, updated_at: new Date().toISOString(), needs_sync: false })
          .eq('view_id', viewId)
          .eq('created_at', from)
      }
    }

    return { value }
  }

  /**
   * Funnel — counts users who progressed through 2–5 ordered events
   * within `conversionWindowSeconds`. Wire shape is `{ steps: [...] }`
   * with cumulative counts + per-step conversion percentages.
   */
  async fetchFunnel(
    connectionId: string,
    viewId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{ steps: FunnelStepRow[]; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from

    this.logger.log(
      `\n  ► fetchFunnel (posthog)\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  dateFrom     : ${from}\n  dateTo       : ${to}`,
    )

    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const steps = (config.steps as FunnelStepConfig[] | undefined) ?? []
    // 7 days is the same default we expose in the picker; if for some reason
    // a view persisted without one (older drafts, manual SQL edits), we fall
    // back to the same value rather than 0 (which would void the funnel).
    const window = (config.conversionWindowSeconds as number | undefined) ?? 86400 * 7

    if (steps.length < 2) {
      this.logger.warn(`  ⚠ Funnel needs ≥2 steps; got ${steps.length}`)
      return { steps: [] }
    }

    return fetchPosthogFunnel(ph, steps, window, from, to, this.logger)
  }

  /**
   * Retention — cohort heatmap. `dateTo` anchors the most-recent cohort row;
   * the cohort window walks back `cohortCount` periods from there. The
   * global picker's `dateFrom` is intentionally ignored here (see comments
   * in `retention.ts:buildRetentionHogql`).
   */
  async fetchRetention(
    connectionId: string,
    viewId: string,
    userId: string,
    _dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    cohorts: RetentionRow[]
    periodLabel: RetentionPeriod
    unavailable?: boolean
  }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const to = dateTo ?? todayStr

    this.logger.log(
      `\n  ► fetchRetention (posthog)\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  dateTo       : ${to}`,
    )

    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const retentionConfig: RetentionConfig = {
      startEvent: (config.startEvent as string | undefined) ?? '$pageview',
      returnEvent: (config.returnEvent as string | undefined) ?? '$pageview',
      period: (config.period as RetentionPeriod | undefined) ?? 'day',
      cohortCount: (config.cohortCount as number | undefined) ?? 7,
      retentionPeriods: (config.retentionPeriods as number | undefined) ?? 7,
    }

    return fetchPosthogRetention(ph, retentionConfig, to, this.logger)
  }

  /**
   * Users — wraps the existing `fetchPosthogUsersList`. No view config
   * required in v1; the date range gates the query window.
   */
  async fetchUsers(
    connectionId: string,
    viewId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{ users: PosthogUserRow[]; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from

    this.logger.log(
      `\n  ► fetchUsers (posthog)\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  dateFrom     : ${from}\n  dateTo       : ${to}`,
    )

    const { ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const users = await fetchPosthogUsersList(ph, from, to, 500, this.logger)
    return { users }
  }
}
