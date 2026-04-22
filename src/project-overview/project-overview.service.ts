import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { UserSettingsService } from '../user-settings/user-settings.service'
import { GoogleAnalyticsOAuthService } from '../google-analytics/connection/oauth'
import { getPosthogCredentials } from '../posthog/connection/credentials'
import {
  getApiKeyInternal,
  makeStripeGetter,
} from '../stripe/views/stripe-api.helpers'
import {
  fetchSourcesByBucket as fetchGASourcesByBucket,
  fetchMetricByBucket as fetchGAMetricByBucket,
  type SourceBucketRow as GASourceRow,
  type BucketGranularity,
} from '../google-analytics/views/live/sources'
import {
  fetchPosthogSourcesByBucket,
  fetchPosthogEventCountByBucket,
  listPosthogEventNames,
} from '../posthog/views/live/sources'
import { fetchStripeRevenueByBucket } from '../stripe/views/live/revenue-by-bucket'
import { normalizeSource } from './source-normalization'

export type OverviewMode = 'daily' | 'weekly' | 'monthly'
export type PrimaryMetric = 'visitors' | 'pageviews' | 'conversions' | 'revenue'
export type SecondaryMetric =
  | 'conversion_rate'
  | 'bounce_rate'
  | 'avg_session_sec'
  | 'revenue'
  | null

export interface OverviewBucket {
  label: string
  total: number
  bySource: { source: string; label: string; color: string; value: number }[]
  secondary: number | null
}

export interface OverviewChartResponse {
  buckets: OverviewBucket[]
  totalPrimary: number
  totalSecondary: number | null
  primaryUnavailable?: boolean
  secondaryUnavailable?: boolean
  trafficProvider: 'google_analytics' | 'posthog' | null
}

export interface OverviewSourcesResponse {
  sources: { source: string; label: string; color: string; visitors: number; share: number }[]
}

interface Bucket {
  /** Label shown on the X-axis */
  label: string
  /** Start of this bucket in UTC */
  start: Date
  /** End (exclusive) of this bucket in UTC */
  end: Date
  /** Keys used by GA / PostHog / unix — precomputed for efficient lookup */
  gaKey: string // "YYYYMMDDHH" hourly, "YYYYMMDD" daily (GA4 dimension format)
  phHourlyKey: string // "YYYY-MM-DDTHH:00:00" posthog hourly
  phDailyKey: string // "YYYY-MM-DD"
  unix: number
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtHourLabel(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm'
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${hour12}${suffix}`
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Build the fixed bucket grid for the requested period. */
function buildBuckets(mode: OverviewMode, dateFrom: string, dateTo: string): Bucket[] {
  const buckets: Bucket[] = []
  const start = new Date(dateFrom + 'T00:00:00Z')

  if (mode === 'daily') {
    // 24 hourly buckets on dateFrom
    for (let h = 0; h < 24; h++) {
      const bs = new Date(start)
      bs.setUTCHours(h, 0, 0, 0)
      const be = new Date(bs)
      be.setUTCHours(h + 1)
      buckets.push({
        label: fmtHourLabel(h),
        start: bs,
        end: be,
        gaKey: `${bs.getUTCFullYear()}${pad2(bs.getUTCMonth() + 1)}${pad2(bs.getUTCDate())}${pad2(h)}`,
        phHourlyKey: `${bs.getUTCFullYear()}-${pad2(bs.getUTCMonth() + 1)}-${pad2(bs.getUTCDate())}T${pad2(h)}:00:00`,
        phDailyKey: `${bs.getUTCFullYear()}-${pad2(bs.getUTCMonth() + 1)}-${pad2(bs.getUTCDate())}`,
        unix: Math.floor(bs.getTime() / 1000),
      })
    }
    return buckets
  }

  // weekly / monthly — daily buckets from dateFrom through dateTo
  const end = new Date(dateTo + 'T00:00:00Z')
  const cursor = new Date(start)
  while (cursor <= end) {
    const bs = new Date(cursor)
    const be = new Date(cursor)
    be.setUTCDate(be.getUTCDate() + 1)
    const label =
      mode === 'weekly'
        ? DAY_LABELS[bs.getUTCDay()]
        : `${MONTH_LABELS[bs.getUTCMonth()]} ${bs.getUTCDate()}`
    buckets.push({
      label,
      start: bs,
      end: be,
      gaKey: `${bs.getUTCFullYear()}${pad2(bs.getUTCMonth() + 1)}${pad2(bs.getUTCDate())}`,
      phHourlyKey: '', // unused for daily mode
      phDailyKey: `${bs.getUTCFullYear()}-${pad2(bs.getUTCMonth() + 1)}-${pad2(bs.getUTCDate())}`,
      unix: Math.floor(bs.getTime() / 1000),
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return buckets
}

@Injectable()
export class ProjectOverviewService {
  private readonly logger = new Logger(ProjectOverviewService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly userSettingsService: UserSettingsService,
    private readonly gaOAuthService: GoogleAnalyticsOAuthService,
  ) {}

  /**
   * Decides which connection provides traffic/sources for a user.
   * Priority: explicit user setting → first GA connection → first PostHog connection → null.
   */
  private async pickTrafficProvider(
    userId: string,
  ): Promise<
    | { type: 'google_analytics'; connectionId: string }
    | { type: 'posthog'; connectionId: string }
    | null
  > {
    const settings = await this.userSettingsService.get(userId)
    const client = this.supabaseService.getClient()

    if (settings.preferredTrafficConnectionId) {
      const { data } = await client
        .from('connections')
        .select('id, type')
        .eq('id', settings.preferredTrafficConnectionId)
        .eq('user_id', userId)
        .maybeSingle()
      if (data && (data.type === 'google_analytics' || data.type === 'posthog')) {
        return { type: data.type as 'google_analytics' | 'posthog', connectionId: data.id as string }
      }
    }

    const { data: ga } = await client
      .from('connections')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'google_analytics')
      .limit(1)
      .maybeSingle()
    if (ga) return { type: 'google_analytics', connectionId: ga.id as string }

    const { data: ph } = await client
      .from('connections')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'posthog')
      .limit(1)
      .maybeSingle()
    if (ph) return { type: 'posthog', connectionId: ph.id as string }

    return null
  }

  private granularity(mode: OverviewMode): BucketGranularity {
    return mode === 'daily' ? 'hourly' : 'daily'
  }

  async fetchChart(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    mode: OverviewMode,
    primaryMetric: PrimaryMetric,
    secondaryMetric: SecondaryMetric,
  ): Promise<OverviewChartResponse> {
    this.logger.log(
      `\n  ► fetchChart  projectId=${projectId} ${mode} ${dateFrom}→${dateTo}  primary=${primaryMetric} secondary=${secondaryMetric ?? 'none'}`,
    )

    const buckets = buildBuckets(mode, dateFrom, dateTo)
    const gran = this.granularity(mode)

    const provider = await this.pickTrafficProvider(userId)
    const settings = await this.userSettingsService.get(userId)

    // Accumulators keyed by bucket index
    const byBucketTotal: number[] = new Array(buckets.length).fill(0)
    const byBucketSources: Map<string, { label: string; color: string; value: number }>[] =
      buckets.map(() => new Map())

    let primaryUnavailable = false

    // ─── Primary metric ───────────────────────────────────────────────────
    if (primaryMetric === 'visitors' || primaryMetric === 'pageviews') {
      if (!provider) {
        primaryUnavailable = true
      } else if (provider.type === 'google_analytics') {
        try {
          const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
          const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)

          if (primaryMetric === 'visitors') {
            const rows = await fetchGASourcesByBucket(token, propertyId, dateFrom, dateTo, gran)
            this.assignSourceRows(buckets, byBucketTotal, byBucketSources, rows)
          } else {
            const rows = await fetchGAMetricByBucket(
              token,
              propertyId,
              'screenPageViews',
              dateFrom,
              dateTo,
              gran,
            )
            this.assignFlatRows(buckets, byBucketTotal, byBucketSources, rows, 'Total')
          }
        } catch (err) {
          this.logger.warn(`GA fetch failed: ${String(err)}`)
          primaryUnavailable = true
        }
      } else if (provider.type === 'posthog') {
        try {
          const ph = await getPosthogCredentials(provider.connectionId, this.supabaseService)
          if (!ph) {
            primaryUnavailable = true
          } else {
            const rows = await fetchPosthogSourcesByBucket(ph, dateFrom, dateTo, gran, this.logger)
            this.assignSourceRows(buckets, byBucketTotal, byBucketSources, rows, 'posthog')
          }
        } catch (err) {
          this.logger.warn(`PostHog fetch failed: ${String(err)}`)
          primaryUnavailable = true
        }
      }
    } else if (primaryMetric === 'conversions') {
      if (!settings.conversionConnectionId || !settings.conversionEvent) {
        primaryUnavailable = true
      } else {
        try {
          const ph = await getPosthogCredentials(settings.conversionConnectionId, this.supabaseService)
          if (ph) {
            const rows = await fetchPosthogEventCountByBucket(
              ph,
              settings.conversionEvent,
              dateFrom,
              dateTo,
              gran,
              this.logger,
            )
            this.assignFlatRows(buckets, byBucketTotal, byBucketSources, rows, 'Conversions')
          } else {
            primaryUnavailable = true
          }
        } catch (err) {
          this.logger.warn(`Conversions fetch failed: ${String(err)}`)
          primaryUnavailable = true
        }
      }
    } else if (primaryMetric === 'revenue') {
      try {
        const amounts = await this.fetchStripeRevenueForProject(userId, projectId, dateFrom, dateTo, gran)
        // amounts are keyed by bucket unix
        const byUnix = new Map(amounts.map(a => [a.bucketUnix, a.value]))
        for (let i = 0; i < buckets.length; i++) {
          const cents = byUnix.get(buckets[i].unix) ?? 0
          const dollars = cents / 100
          if (dollars > 0) {
            byBucketTotal[i] += dollars
            const rev = normalizeSource('stripe') // falls to "other" but we'll override label
            byBucketSources[i].set('revenue', { label: 'Revenue', color: '#635bff', value: dollars })
          }
        }
      } catch (err) {
        this.logger.warn(`Stripe revenue fetch failed: ${String(err)}`)
        primaryUnavailable = true
      }
    }

    // ─── Secondary metric (line series) ───────────────────────────────────
    const bySecondary: (number | null)[] = new Array(buckets.length).fill(null)
    let secondaryUnavailable = false
    let totalSecondary: number | null = null

    if (secondaryMetric === 'revenue') {
      try {
        const amounts = await this.fetchStripeRevenueForProject(userId, projectId, dateFrom, dateTo, gran)
        const byUnix = new Map(amounts.map(a => [a.bucketUnix, a.value]))
        let sum = 0
        for (let i = 0; i < buckets.length; i++) {
          const dollars = (byUnix.get(buckets[i].unix) ?? 0) / 100
          bySecondary[i] = dollars
          sum += dollars
        }
        totalSecondary = sum
      } catch {
        secondaryUnavailable = true
      }
    } else if (secondaryMetric === 'bounce_rate' || secondaryMetric === 'avg_session_sec') {
      if (provider?.type !== 'google_analytics') {
        secondaryUnavailable = true
      } else {
        try {
          const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
          const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
          const metric = secondaryMetric === 'bounce_rate' ? 'bounceRate' : 'averageSessionDuration'
          const rows = await fetchGAMetricByBucket(token, propertyId, metric, dateFrom, dateTo, gran)
          const byKey = new Map(rows.map(r => [r.bucketKey, r.value]))
          let count = 0
          let sum = 0
          for (let i = 0; i < buckets.length; i++) {
            const v = byKey.get(buckets[i].gaKey) ?? null
            bySecondary[i] = v
            if (v != null) {
              sum += v
              count++
            }
          }
          totalSecondary = count > 0 ? sum / count : null
        } catch {
          secondaryUnavailable = true
        }
      }
    } else if (secondaryMetric === 'conversion_rate') {
      if (!provider || !settings.conversionConnectionId || !settings.conversionEvent) {
        secondaryUnavailable = true
      } else {
        try {
          // Denominator = sessions per bucket from traffic provider
          let sessionsByKey: Map<string, number> = new Map()
          if (provider.type === 'google_analytics') {
            const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
            const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
            const rows = await fetchGAMetricByBucket(
              token,
              propertyId,
              'sessions',
              dateFrom,
              dateTo,
              gran,
            )
            sessionsByKey = new Map(rows.map(r => [r.bucketKey, r.value]))
          } else {
            const ph = await getPosthogCredentials(provider.connectionId, this.supabaseService)
            if (ph) {
              const rows = await fetchPosthogSourcesByBucket(ph, dateFrom, dateTo, gran, this.logger)
              for (const r of rows) {
                const k = r.bucketKey
                sessionsByKey.set(k, (sessionsByKey.get(k) ?? 0) + r.value)
              }
            }
          }

          const ph = await getPosthogCredentials(settings.conversionConnectionId, this.supabaseService)
          let conversionsByKey = new Map<string, number>()
          if (ph) {
            const rows = await fetchPosthogEventCountByBucket(
              ph,
              settings.conversionEvent,
              dateFrom,
              dateTo,
              gran,
              this.logger,
            )
            conversionsByKey = new Map(rows.map(r => [r.bucketKey, r.value]))
          }

          let totalConv = 0
          let totalSess = 0
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i]
            const sessKey = provider.type === 'google_analytics' ? b.gaKey : (gran === 'hourly' ? b.phHourlyKey : b.phDailyKey)
            const convKey = gran === 'hourly' ? b.phHourlyKey : b.phDailyKey
            const sess = sessionsByKey.get(sessKey) ?? 0
            const conv = conversionsByKey.get(convKey) ?? 0
            totalConv += conv
            totalSess += sess
            bySecondary[i] = sess > 0 ? (conv / sess) * 100 : null
          }
          totalSecondary = totalSess > 0 ? (totalConv / totalSess) * 100 : null
        } catch {
          secondaryUnavailable = true
        }
      }
    }

    // ─── Build response ────────────────────────────────────────────────────
    const outBuckets: OverviewBucket[] = buckets.map((b, i) => ({
      label: b.label,
      total: byBucketTotal[i],
      bySource: Array.from(byBucketSources[i].entries())
        .map(([key, v]) => ({ source: key, label: v.label, color: v.color, value: v.value }))
        .sort((a, b) => b.value - a.value),
      secondary: bySecondary[i],
    }))

    const totalPrimary = byBucketTotal.reduce((a, b) => a + b, 0)

    return {
      buckets: outBuckets,
      totalPrimary,
      totalSecondary,
      primaryUnavailable: primaryUnavailable || undefined,
      secondaryUnavailable: secondaryUnavailable || undefined,
      trafficProvider: provider?.type ?? null,
    }
  }

  async fetchSources(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    limit = 10,
  ): Promise<OverviewSourcesResponse> {
    this.logger.log(
      `\n  ► fetchSources  projectId=${projectId} ${dateFrom}→${dateTo}  limit=${limit}`,
    )

    const provider = await this.pickTrafficProvider(userId)
    if (!provider) return { sources: [] }

    // Reuse the per-bucket fetchers; aggregate across buckets to a single source list.
    const gran: BucketGranularity = 'daily'
    let rows: { source: string; value: number }[] = []

    try {
      if (provider.type === 'google_analytics') {
        const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
        const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
        const all = await fetchGASourcesByBucket(token, propertyId, dateFrom, dateTo, gran)
        rows = all.map(r => ({ source: r.source, value: r.value }))
      } else {
        const ph = await getPosthogCredentials(provider.connectionId, this.supabaseService)
        if (ph) {
          const all = await fetchPosthogSourcesByBucket(ph, dateFrom, dateTo, gran, this.logger)
          rows = all.map(r => ({ source: r.source, value: r.value }))
        }
      }
    } catch (err) {
      this.logger.warn(`fetchSources provider error: ${String(err)}`)
      return { sources: [] }
    }

    // Group + normalise
    const byKey = new Map<string, { label: string; color: string; value: number }>()
    for (const r of rows) {
      const n = normalizeSource(r.source)
      const existing = byKey.get(n.key)
      if (existing) existing.value += r.value
      else byKey.set(n.key, { label: n.label, color: n.color, value: r.value })
    }

    const total = Array.from(byKey.values()).reduce((acc, v) => acc + v.value, 0)
    const sorted = Array.from(byKey.entries())
      .map(([source, v]) => ({
        source,
        label: v.label,
        color: v.color,
        visitors: v.value,
        share: total > 0 ? v.value / total : 0,
      }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, limit)

    return { sources: sorted }
  }

  async listConversionEvents(
    userId: string,
    connectionId: string,
  ): Promise<{ events: { name: string }[] }> {
    // Verify ownership
    const { data: conn } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) return { events: [] }

    if (conn.type === 'posthog') {
      const ph = await getPosthogCredentials(connectionId, this.supabaseService)
      if (!ph) return { events: [] }
      const names = await listPosthogEventNames(ph, this.logger)
      return { events: names.map(name => ({ name })) }
    }

    // GA event names are a property — we don't enumerate them for now.
    // Users targeting GA can type their event name manually in settings (v2 enhancement).
    return { events: [] }
  }

  /**
   * Helper: sum all stripe revenue across every Stripe manual connection on the project.
   * Project→connections relationship: connections aren't strictly scoped to projects today,
   * so we pull all of this user's stripe_manual connections.
   * Note: projectId is accepted for future scoping but currently unused.
   */
  private async fetchStripeRevenueForProject(
    userId: string,
    _projectId: string,
    dateFrom: string,
    dateTo: string,
    gran: BucketGranularity,
  ): Promise<{ bucketUnix: number; value: number }[]> {
    const { data: conns } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type')
      .eq('user_id', userId)
      .eq('type', 'stripe_manual')

    if (!conns || conns.length === 0) return []

    const merged = new Map<number, number>()
    for (const c of conns) {
      try {
        const apiKey = await getApiKeyInternal(c.id as string, this.supabaseService)
        const get = makeStripeGetter(apiKey)
        const rows = await fetchStripeRevenueByBucket(get, dateFrom, dateTo, gran)
        for (const r of rows) merged.set(r.bucketUnix, (merged.get(r.bucketUnix) ?? 0) + r.value)
      } catch (err) {
        this.logger.warn(`Stripe connection ${c.id} failed: ${String(err)}`)
      }
    }
    return Array.from(merged.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketUnix, value]) => ({ bucketUnix, value }))
  }

  /**
   * Assign GA source rows (keyed by gaKey) into the bucket grid.
   * When `providerType === 'posthog'`, interpret `bucketKey` using PostHog formats instead.
   */
  private assignSourceRows(
    buckets: Bucket[],
    totals: number[],
    sources: Map<string, { label: string; color: string; value: number }>[],
    rows: GASourceRow[],
    providerType: 'ga' | 'posthog' = 'ga',
  ): void {
    const keyIndex = new Map<string, number>()
    for (let i = 0; i < buckets.length; i++) {
      if (providerType === 'ga') {
        keyIndex.set(buckets[i].gaKey, i)
      } else {
        // Posthog bucket rows can arrive in either format — index both
        if (buckets[i].phHourlyKey) keyIndex.set(buckets[i].phHourlyKey, i)
        keyIndex.set(buckets[i].phDailyKey, i)
      }
    }

    for (const r of rows) {
      const idx = keyIndex.get(r.bucketKey)
      if (idx === undefined) continue
      const n = normalizeSource(r.source)
      totals[idx] += r.value
      const existing = sources[idx].get(n.key)
      if (existing) existing.value += r.value
      else sources[idx].set(n.key, { label: n.label, color: n.color, value: r.value })
    }
  }

  /**
   * Assign per-bucket rows with no source breakdown into a single "Total" segment.
   */
  private assignFlatRows(
    buckets: Bucket[],
    totals: number[],
    sources: Map<string, { label: string; color: string; value: number }>[],
    rows: { bucketKey: string; value: number }[],
    label: string,
  ): void {
    const keyIndex = new Map<string, number>()
    for (let i = 0; i < buckets.length; i++) {
      keyIndex.set(buckets[i].gaKey, i)
      if (buckets[i].phHourlyKey) keyIndex.set(buckets[i].phHourlyKey, i)
      keyIndex.set(buckets[i].phDailyKey, i)
    }

    for (const r of rows) {
      const idx = keyIndex.get(r.bucketKey)
      if (idx === undefined) continue
      totals[idx] += r.value
      const existing = sources[idx].get('total')
      if (existing) existing.value += r.value
      else sources[idx].set('total', { label, color: '#4f46e5', value: r.value })
    }
  }
}
