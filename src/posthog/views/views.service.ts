import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ConnectionMissingException } from '../../common/integration-errors'
import { buildViewFetchContext } from '../../common/view-fetch-context'
import {
  escapeDateLiteral,
  escapeStringLiteral,
  tzDateBucket,
  tzWrappedTimestamp,
} from './live/hogql-utils'
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
    tz: string = 'UTC',
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const { from, to, isSingleDay, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)

    this.logger.log(
      `fetchLiveValue (posthog)  connectionId=${connectionId}  viewId=${viewId}  ${from}→${to}  tz=${tzLit}`,
    )

    const client = this.supabaseService.getClient()
    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const eventName = (config.eventName as string | undefined) ?? ''

    if (!eventName) {
      this.logger.warn('No eventName in view config — returning 0')
      return { value: '0' }
    }

    const safeEvent = escapeStringLiteral(eventName)
    const safeFrom = escapeDateLiteral(from)
    const safeTo = escapeDateLiteral(to)
    // Parens around BETWEEN are load-bearing — HogQL's AND binds tighter
    // than BETWEEN, so without them the parser reads
    // `(event = X AND toDate(timestamp)) BETWEEN …` and crashes on the
    // string-AND-Date type mismatch. `tzDateBucket` returns the
    // `toDate(toTimeZone(...))` chain HogQL needs.
    const hogqlQuery = `SELECT count() FROM events WHERE event = '${safeEvent}' AND (${tzDateBucket(tzLit)} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}'))`

    this.logger.debug(`PostHog HogQL: ${hogqlQuery}`)

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
      this.logger.error(`PostHog query API ${res.status}: ${JSON.stringify(body)}`)
      // Surfaces as 500 to the frontend; the user-facing message is
      // generic ("Couldn't load this view.") via `viewErrorMessage`.
      throw new InternalServerErrorException(`PostHog query API error ${res.status}`)
    }

    const json = (await res.json()) as { results?: [[number]] }
    const count = json.results?.[0]?.[0] ?? 0
    const value = String(count)

    this.logger.log(`fetchLiveValue → ${value}`)

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
   * Time-series chart for `daily_counter` views in chart mode
   * (`config.displayMode === 'chart'`). Returns one bucket per
   * day-or-hour over the requested range — same `ChartPoint`-style
   * shape as the Stripe + GA chart endpoints, so the frontend can
   * funnel them through the shared `<ViewCardChart>` renderer.
   *
   * Bucketing rules mirror the other providers:
   *   - single-day request → 24 hourly buckets, labelled "12am" … "11pm"
   *   - multi-day request  → one bucket per day, labelled by day-of-week
   *
   * Authentication: same ownership check as `fetchLiveValue` via
   * `loadViewAndCreds`. The HogQL is parameterised the same way, with
   * `escapeStringLiteral` / `escapeDateLiteral` to keep the same SQLi
   * defenses as the live-value path.
   */
  async fetchChartData(
    connectionId: string,
    viewId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    tz: string = 'UTC',
  ): Promise<{ points: { label: string; value: number }[]; unavailable?: boolean }> {
    const { from, to, isSingleDay, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)

    this.logger.log(
      `fetchChartData (posthog daily_counter)  connectionId=${connectionId}  viewId=${viewId}  ${from}→${to}  tz=${tzLit}`,
    )

    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const eventName = (config.eventName as string | undefined) ?? ''
    if (!eventName) {
      this.logger.warn('No eventName in view config — returning empty chart')
      return { points: [] }
    }

    const safeEvent = escapeStringLiteral(eventName)
    const safeFrom = escapeDateLiteral(from)
    const safeTo = escapeDateLiteral(to)

    // For a single-day request we bucket by hour; for ranges, by day. The
    // bucket dimension stays inside the WHERE-filtered subquery so we don't
    // pull non-matching events into the timezone-bucketing math.
    //
    // Use `tzWrappedTimestamp` for the inner `toTimeZone(...)` instead of
    // hand-rolling — the helper quotes the tz literal correctly. An
    // earlier draft inlined `toTimeZone(timestamp, ${tzLit})` (no quotes
    // around the tz string), which caused HogQL to parse the timezone
    // name as a column reference and 500 the request — surfaced to the
    // user as the "Couldn't load value" badge in daily mode while
    // weekly/monthly worked fine (those go through `tzDateBucket`,
    // which already routes through the helper).
    const bucketExpr = isSingleDay
      ? `toHour(${tzWrappedTimestamp(tzLit)})`
      : tzDateBucket(tzLit)
    const hogqlQuery =
      `SELECT ${bucketExpr} AS b, count() ` +
      `FROM events WHERE event = '${safeEvent}' AND ` +
      `(${tzDateBucket(tzLit)} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) ` +
      `GROUP BY b ORDER BY b`

    this.logger.debug(`PostHog HogQL: ${hogqlQuery}`)

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
      this.logger.error(`PostHog query API ${res.status}: ${JSON.stringify(body)}`)
      throw new InternalServerErrorException(`PostHog query API error ${res.status}`)
    }

    // Daily mode returns "YYYY-MM-DD" date strings; hourly mode returns
    // integer hour-of-day (0..23). Both come back as a single-row tuple
    // shape from PostHog: `[bucketKey, count]`.
    const json = (await res.json()) as { results?: [string | number, number][] }
    const rows = json.results ?? []

    const points = isSingleDay
      ? bucketHourly(rows as [number, number][], from)
      : bucketDaily(rows as [string, number][], from, to)

    return { points }
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
    tz: string = 'UTC',
  ): Promise<{ steps: FunnelStepRow[]; unavailable?: boolean }> {
    const { from, to, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)

    this.logger.log(
      `fetchFunnel (posthog)  connectionId=${connectionId}  viewId=${viewId}  ${from}→${to}  tz=${tzLit}`,
    )

    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const steps = (config.steps as FunnelStepConfig[] | undefined) ?? []
    // 7 days is the same default we expose in the picker; if for some reason
    // a view persisted without one (older drafts, manual SQL edits), we fall
    // back to the same value rather than 0 (which would void the funnel).
    const window = (config.conversionWindowSeconds as number | undefined) ?? 86400 * 7

    if (steps.length < 2) {
      this.logger.warn(`Funnel needs ≥2 steps; got ${steps.length}`)
      return { steps: [] }
    }

    return fetchPosthogFunnel(ph, steps, window, from, to, this.logger, tzLit)
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
    tz: string = 'UTC',
  ): Promise<{
    cohorts: RetentionRow[]
    periodLabel: RetentionPeriod
    unavailable?: boolean
  }> {
    const { to, tz: tzLit } = buildViewFetchContext(undefined, dateTo, tz)

    this.logger.log(
      `fetchRetention (posthog)  connectionId=${connectionId}  viewId=${viewId}  dateTo=${to}  tz=${tzLit}`,
    )

    const { config, ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const retentionConfig: RetentionConfig = {
      startEvent: (config.startEvent as string | undefined) ?? '$pageview',
      returnEvent: (config.returnEvent as string | undefined) ?? '$pageview',
      period: (config.period as RetentionPeriod | undefined) ?? 'day',
      cohortCount: (config.cohortCount as number | undefined) ?? 7,
      retentionPeriods: (config.retentionPeriods as number | undefined) ?? 7,
    }

    return fetchPosthogRetention(ph, retentionConfig, to, this.logger, tzLit)
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
    tz: string = 'UTC',
  ): Promise<{ users: PosthogUserRow[]; unavailable?: boolean }> {
    const { from, to, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)

    this.logger.log(
      `fetchUsers (posthog)  connectionId=${connectionId}  viewId=${viewId}  ${from}→${to}  tz=${tzLit}`,
    )

    const { ph } = await this.loadViewAndCreds(connectionId, viewId, userId)
    const users = await fetchPosthogUsersList(ph, from, to, 500, this.logger, tzLit)
    return { users }
  }
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Convert PostHog hourly rows ([hourOfDay, count]) into 24 ordered points
 * with `12am`/`1am`/.../`11pm` labels. Mirrors the Stripe + GA hourly chart
 * shape so `<ViewCardChart>` renders identically across providers. For
 * "today" we truncate to current-hour-plus-one (matches the Stripe chart's
 * "no future bars" behaviour).
 */
function bucketHourly(
  rows: [number, number][],
  dateStr: string,
): { label: string; value: number }[] {
  const todayStr = new Date().toISOString().split('T')[0]
  const isToday = dateStr === todayStr
  const hoursInBucket = isToday ? new Date().getUTCHours() + 1 : 24

  const buckets = new Array<number>(hoursInBucket).fill(0)
  for (const [h, c] of rows) {
    if (typeof h === 'number' && h >= 0 && h < hoursInBucket) buckets[h] = c
  }
  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}

/**
 * Convert PostHog daily rows ([YYYY-MM-DD, count]) into one ordered point
 * per day in [dateFrom, dateTo], labelled by day-of-week to match the
 * Stripe + GA weekly/monthly chart layout.
 */
function bucketDaily(
  rows: [string, number][],
  dateFrom: string,
  dateTo: string,
): { label: string; value: number }[] {
  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end = new Date(`${dateTo}T00:00:00Z`)
  const numDays =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1

  const byKey = new Map<string, number>()
  for (const [dateKey, count] of rows) byKey.set(dateKey, count)

  const out: { label: string; value: number }[] = new Array(numDays)
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    const key = d.toISOString().split('T')[0]
    out[i] = {
      label: DAY_LABELS[d.getUTCDay()],
      value: byKey.get(key) ?? 0,
    }
  }
  return out
}

function fmtHour(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}
