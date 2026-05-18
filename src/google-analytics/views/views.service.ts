import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
import { buildViewFetchContext } from '../../common/view-fetch-context'
import { metricForViewType, fetchRealtimeActiveUsers, fetchTodayMetric } from './live/metrics'
import { fetchMetricByBucket, type BucketGranularity } from './live/sources'
import { hourlyBucketCount } from '../../common/tz'

type ChartMode = 'daily' | 'weekly' | 'monthly'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// View types that can render in chart mode (config.displayMode === 'chart').
// `ga_active_users` is intentionally excluded — the Realtime API is a
// snapshot; there's no historical series to plot.
const CHART_VIEW_TYPES = new Set([
  'ga_users_today',
  'ga_sessions_today',
  'ga_pageviews_today',
])

@Injectable()
export class GoogleAnalyticsViewsService {
  private readonly logger = new Logger(GoogleAnalyticsViewsService.name)

  constructor(
    private readonly oauthService: GoogleAnalyticsOAuthService,
    private readonly viewsService: ViewsService,
  ) {}

  async fetchLiveValue(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    tz: string = 'UTC',
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const { from, to, isSingleDay, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)
    // GA's realtime endpoint is the only one without a historical mode —
    // we keep `isToday` as a separate flag from the generic
    // `isSingleDay` because they aren't the same idea (a single-day
    // query for *yesterday* is single-day but not today).
    const isToday = from === todayStr && to === todayStr

    this.logger.log(
      `fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}  tz=${tzLit}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    let value: string

    if (viewType === 'ga_active_users') {
      if (!isToday) {
        // Realtime API only produces a current snapshot — no past-range equivalent.
        this.logger.log('ga_active_users requested for non-today range — unavailable')
        return { value: null, unavailable: true }
      }
      // Realtime is "right now" — no date range to align, no tz to thread.
      value = await fetchRealtimeActiveUsers(token, connectionId, propertyId)
    } else {
      // GA's runReport doesn't support a per-request `timeZone` — it
      // always evaluates `dateRanges` in the property's configured zone.
      // We accept `tz` for parity with the other integrations but drop
      // it on the floor here (project-overview's chart logs a warning
      // when GA's property tz disagrees with the user's tz).
      const metricName = metricForViewType(viewType)
      value = await fetchTodayMetric(token, connectionId, propertyId, metricName, from, to)
    }

    // Only persist stored daily values for single-day queries.
    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`fetchLiveValue → ${value}`)
    return { value }
  }

  /**
   * Time-series chart for the polymorphic `ga_users_today` /
   * `ga_sessions_today` / `ga_pageviews_today` types when the view's
   * `config.displayMode === 'chart'`. Returns `ChartPoint[]` shaped to
   * match `<ViewCardChart>`'s wire format (label + value), reusing the
   * same per-bucket helpers as project-overview so the bucketing math
   * is consistent.
   *
   * `mode` controls bucketing:
   *   - 'daily' or single-day request → hourly buckets (24 points)
   *   - 'weekly' / 'monthly' → daily buckets, day-of-week labels
   *
   * No `tz` parameter — same caveat as `fetchLiveValue`: GA's runReport
   * is property-tz only. project-overview already logs a warning when
   * the user's tz differs from the property tz; we don't duplicate it
   * here.
   */
  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    mode?: ChartMode,
    tz: string = 'UTC',
  ): Promise<{ points: { label: string; value: number }[]; unavailable?: boolean }> {
    if (!CHART_VIEW_TYPES.has(viewType)) {
      throw new NotFoundException(`No chart data for GA view type: ${viewType}`)
    }

    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from

    this.logger.log(
      `fetchChartData (ga)  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}  mode=${mode ?? '?'}  tz=${tz}`,
    )

    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    const granularity: BucketGranularity =
      mode === 'daily' || (!mode && from === to) ? 'hourly' : 'daily'

    const metricName = metricForViewType(viewType)
    const rows = await fetchMetricByBucket(
      token,
      connectionId,
      propertyId,
      metricName,
      from,
      to,
      granularity,
    )

    // GA bucketKey shapes:
    //   hourly → "YYYYMMDDHH" (e.g. "2026050614")
    //   daily  → "YYYYMMDD"   (e.g. "20260506")
    const points = granularity === 'hourly'
      ? bucketHourlyByGAKey(rows, from, tz)
      : bucketDailyByGAKey(rows, from, to)

    return { points }
  }
}

/**
 * Convert GA hourly rows (bucketKey="YYYYMMDDHH") into ordered points
 * with `12am`/`1am`/.../`11pm` labels — matches the Stripe hourly chart
 * output so `<ViewCardChart>` renders identically.
 *
 * Truncation uses the user's tz so the "no future bars" boundary matches
 * the wall clock the user is looking at. The GA hour digits themselves
 * are in PROPERTY-tz (not user-tz) — `runReport` only respects the GA4
 * property's configured timezone, with no per-request tz override. That
 * means rows AND truncation may be off by `userTz - propertyTz` for the
 * trailing/leading hour. The project-overview service already warns
 * when those two zones differ; we accept the residual misalignment here
 * for the same reason (full fix would require a `dateHourMinute`
 * dimension + backend rebucketing — out of scope for this view).
 */
function bucketHourlyByGAKey(
  rows: { bucketKey: string; value: number }[],
  dateStr: string,
  tz: string,
): { label: string; value: number }[] {
  const hoursInBucket = hourlyBucketCount(dateStr, tz)

  const buckets = new Array<number>(hoursInBucket).fill(0)
  for (const r of rows) {
    // Last two chars are the hour (in GA property tz — see docstring).
    const hour = parseInt(r.bucketKey.slice(-2), 10)
    if (!Number.isNaN(hour) && hour < hoursInBucket) buckets[hour] += r.value
  }
  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}

/**
 * Convert GA daily rows (bucketKey="YYYYMMDD") into one point per day in
 * [dateFrom, dateTo], labelled by day-of-week to match Stripe's weekly /
 * monthly chart.
 */
function bucketDailyByGAKey(
  rows: { bucketKey: string; value: number }[],
  dateFrom: string,
  dateTo: string,
): { label: string; value: number }[] {
  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end = new Date(`${dateTo}T00:00:00Z`)
  const numDays =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1

  const buckets = new Array<number>(numDays).fill(0)
  const byKey = new Map<string, number>()
  for (const r of rows) byKey.set(r.bucketKey, r.value)

  for (let i = 0; i < numDays; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    const key = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
    buckets[i] = byKey.get(key) ?? 0
  }

  return buckets.map((value, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return { label: DAY_LABELS[d.getUTCDay()], value }
  })
}

function fmtHour(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
