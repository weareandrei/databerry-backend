import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { ConnectionsRepository } from '../connections/connections.repository'
import { StripeRepository } from '../stripe/stripe.repository'
import { UserSettingsService } from '../user-settings/user-settings.service'
import {
  ProjectSettingsService,
  type ProjectSettings,
} from '../project-settings/project-settings.service'
import { GoogleAnalyticsOAuthService } from '../google-analytics/connection/oauth'
import {
  GoogleAnalyticsDataClient,
  type SourceBucketRow as GASourceRow,
  type BucketGranularity,
} from '../google-analytics/google-analytics-data.client'
import { getPosthogCredentials, PosthogCredentialsService } from '../posthog/connection/credentials'
import { PosthogApiClient } from '../posthog/posthog-api.client'
import {
  fetchPosthogSourcesByBucket,
  fetchPosthogEventCountByBucket,
  fetchPosthogVisitorsTotal,
  listPosthogEventNames,
} from '../posthog/views/live/sources'
import { fetchPosthogUsersList } from '../posthog/views/live/users'
import { fetchPosthogCountriesList } from '../posthog/views/live/countries'
import { fetchPosthogPagesList } from '../posthog/views/live/pages'
import { fetchStripeRevenueByBucketFromStorage } from '../stripe/views/live/revenue-by-bucket'
import {
  getConnectionProductFilter,
  getStripeAccountIdForConnection,
} from '../stripe/views/storage-queries'
import { normalizeSource } from './source-normalization'
import {
  dateStrInTz,
  gaDateHourKeyInTz,
  localMidnightUtc,
  phHourlyKeyInTz,
} from '../common/tz'

import type { ChartMode } from '../common/types'

/** Alias kept for the existing import surface (controller, frontend
 *  mirror) — canonical union lives in `common/types.ts`. */
export type OverviewMode = ChartMode
export type PrimaryMetric = 'visitors' | 'pageviews' | 'conversions' | 'revenue'
export type SecondaryMetric =
  | 'conversion_rate'
  | 'bounce_rate'
  | 'avg_session_sec'
  | 'revenue'
  | null

/**
 * The connection that drives the traffic/sources panel for a project.
 * `pickTrafficProvider` returns one of these (or null when no eligible
 * connection is set). Carried through `fetchChart` as part of the
 * shared context object so the metric accumulators don't each have to
 * thread the same value.
 */
export type TrafficProvider =
  | { type: 'google_analytics'; connectionId: string }
  | { type: 'posthog'; connectionId: string }

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
  /**
   * `null` when no traffic provider is connected for this project,
   * otherwise the connected provider. Lets the frontend tell "connect
   * an analytics tool" apart from "connected, but no traffic in this
   * range" — mirrors the `provider` field the countries / pages / users
   * responses already return. Without it the sources panel showed
   * "No analytics tool connected yet." on any empty result, including
   * a live connection with zero traffic for the day.
   */
  provider: 'google_analytics' | 'posthog' | null
}

export interface OverviewUser {
  /** Opaque per-user identifier from the provider (PostHog `distinct_id`). */
  pseudoId: string
  /** Raw source (domain or sentinel). Normalised + reused for colour/label. */
  source: string
  label: string
  color: string
  /** Active span within the range, in seconds. */
  sessionSec: number
  /** ISO-8601 timestamp of the user's most recent pageview. */
  lastSeen: string
}

export interface OverviewCountry {
  /** ISO 3166-1 alpha-2 code (e.g. 'US', 'GB'). Stable key for flags. */
  countryCode: string
  /** Display name. May be empty when PostHog didn't denormalise the name. */
  countryName: string
  /** Distinct-visitor count from this country in the range. */
  visitors: number
  /** Share of the panel total (0–1). Precomputed server-side. */
  share: number
}

export interface OverviewCountriesResponse {
  countries: OverviewCountry[]
  /**
   * `null` when no provider is connected, `'google_analytics'` when GA
   * is the project's traffic source (currently unsupported for the
   * per-country rollup — same rationale as the legacy users panel),
   * `'posthog'` for successful queries.
   */
  provider: 'google_analytics' | 'posthog' | null
}

/** One row of the Pages tab. `share` is pageview-based. */
export interface OverviewPage {
  path: string
  pageviews: number
  visitors: number
  share: number
}

export interface OverviewPagesResponse {
  pages: OverviewPage[]
  /** Same provider semantics as the countries response. Pages are
   *  supported on BOTH providers (GA via `pagePath`, PostHog via
   *  `$pathname`). */
  provider: 'google_analytics' | 'posthog' | null
}

export interface OverviewUsersResponse {
  users: OverviewUser[]
  /**
   * `null` when no connection is configured, `'google_analytics'` when the
   * project's traffic provider is GA (currently unsupported for per-user
   * rollups — frontend renders a "switch to PostHog" empty state), or
   * `'posthog'` when results are from PostHog.
   */
  provider: 'google_analytics' | 'posthog' | null
}

/**
 * Per-bucket source breakdown — keyed by normalised source key
 * (`google`, `direct`, `other:tinylaunch.com`, …). Mutated in place by
 * the metric accumulators; flattened into `OverviewBucket.bySource` at
 * response-build time.
 */
type BucketSourceMap = Map<
  string,
  { label: string; color: string; value: number }
>

/**
 * Shared fetch context for the chart — bundles the inputs that all
 * three pipeline stages (primary metric, secondary metric, response
 * build) need so each can be a single-arg method.
 */
interface ChartFetchContext {
  userId: string
  projectId: string
  dateFrom: string
  dateTo: string
  gran: BucketGranularity
  tz: string
  provider: TrafficProvider | null
  projectSettings: ProjectSettings
  buckets: Bucket[]
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

/**
 * Build the fixed bucket grid for the requested period, in `tz`.
 *
 * Daily mode anchors at *local* midnight (`tz`) so the 24 hourly buckets
 * cover the user's day, not UTC's day. Weekly/monthly modes still iterate
 * UTC days — see plan note: shift across midnight for extreme tz offsets is
 * a known follow-up.
 */
function buildBuckets(
  mode: OverviewMode,
  dateFrom: string,
  dateTo: string,
  tz: string = 'UTC',
): Bucket[] {
  const buckets: Bucket[] = []

  if (mode === 'daily') {
    // 24 hourly buckets on dateFrom, each one hour wide, anchored at the
    // user-local midnight in `tz`. We add `h * 3600 * 1000` rather than
    // `setUTCHours(h)` because DST transitions inside the day would skew an
    // hour-of-day setter; epoch-ms math is unambiguous.
    const startUtc = localMidnightUtc(dateFrom, tz)
    for (let h = 0; h < 24; h++) {
      const bs = new Date(startUtc.getTime() + h * 3600_000)
      const be = new Date(bs.getTime() + 3600_000)
      buckets.push({
        // h here is the *user-local* hour (0..23) by construction, since bs
        // is N hours past local midnight in tz. fmtHourLabel(h) is correct.
        label: fmtHourLabel(h),
        start: bs,
        end: be,
        gaKey: gaDateHourKeyInTz(bs, tz),
        phHourlyKey: phHourlyKeyInTz(bs, tz),
        phDailyKey: dateStrInTz(bs, tz),
        unix: Math.floor(bs.getTime() / 1000),
      })
    }
    return buckets
  }

  // weekly / monthly — daily buckets from dateFrom through dateTo (UTC days).
  const start = new Date(dateFrom + 'T00:00:00Z')
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
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly stripeRepository: StripeRepository,
    private readonly posthogCredentialsService: PosthogCredentialsService,
    private readonly userSettingsService: UserSettingsService,
    private readonly projectSettingsService: ProjectSettingsService,
    private readonly gaOAuthService: GoogleAnalyticsOAuthService,
  ) {}

  /**
   * Decides which connection provides traffic/sources for a user+project.
   *
   * Priority:
   *   1. explicit user setting (the one the user picked in Settings as
   *      "my default traffic source"). May be Common — that's the
   *      *intentional* opt-in path for "this connection powers every
   *      project of mine."
   *   2. A connection scoped to THIS project (`project_id = projectId`)
   *      — GA first, then PostHog.
   *   3. null → frontend renders the "No analytics tool connected yet"
   *      empty state with a CTA to the in-place picker (which can then
   *      reassign an existing Common connection to this project).
   *
   * Notes on the "Common" (`project_id IS NULL`) escape hatch:
   *
   *   The old behaviour auto-fell-back to ANY Common GA / PostHog
   *   connection in step 2 (`.or('project_id.eq.X,project_id.is.null')`).
   *   That silently leaked data across projects: PostHog has no per-
   *   domain filter in our HogQL queries (events are commingled across
   *   every site that points at the same PH project), so a single Common
   *   PostHog showed IDENTICAL totals on every project's overview tab.
   *   Users — quite reasonably — read "no GA connected" as "no data"
   *   and were confused to see numbers anyway.
   *
   *   We now require an EXPLICIT decision per project. A Common
   *   connection can still serve all projects via the preferred-setting
   *   path (step 1) — but never by accident. The OAuth callback still
   *   creates new GA/PostHog connections as Common; the user's next
   *   step is to assign them via the TrafficConnectionPicker (which
   *   already exists for the empty-state CTA).
   */
  private async pickTrafficProvider(
    userId: string,
    projectId: string,
  ): Promise<TrafficProvider | null> {
    const settings = await this.userSettingsService.get(userId)

    if (settings.preferredTrafficConnectionId) {
      const { data } = await this.connectionsRepository.findPreferredTrafficConnection(
        settings.preferredTrafficConnectionId,
        userId,
        projectId,
      )
      if (data && (data.type === 'google_analytics' || data.type === 'posthog')) {
        return { type: data.type as 'google_analytics' | 'posthog', connectionId: data.id as string }
      }
    }

    // Strict project-specific lookup. No `.or(project_id.is.null)` —
    // see the docstring above for why Common is no longer an auto-pick.
    for (const type of ['google_analytics', 'posthog'] as const) {
      const { data } = await this.connectionsRepository.findProjectScopedByType(
        userId,
        type,
        projectId,
      )
      if (data) return { type, connectionId: data.id as string }
    }

    return null
  }

  private granularity(mode: OverviewMode): BucketGranularity {
    return mode === 'daily' ? 'hourly' : 'daily'
  }

  /**
   * Orchestrates the chart fetch: prep buckets, pick the traffic
   * provider, accumulate the primary + secondary metrics into shared
   * arrays, build the response.
   *
   * The two `accumulate*` helpers carry most of the per-metric logic;
   * this function stays orchestration-focused so the lifecycle reads
   * top-down (provider → primary → secondary → response).
   */
  async fetchChart(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    mode: OverviewMode,
    primaryMetric: PrimaryMetric,
    secondaryMetric: SecondaryMetric,
    tz: string = 'UTC',
  ): Promise<OverviewChartResponse> {
    this.logger.log(
      `fetchChart  projectId=${projectId} ${mode} ${dateFrom}→${dateTo}  primary=${primaryMetric} secondary=${secondaryMetric ?? 'none'} tz=${tz}`,
    )

    const buckets = buildBuckets(mode, dateFrom, dateTo, tz)
    const gran = this.granularity(mode)
    const provider = await this.pickTrafficProvider(userId, projectId)
    const projectSettings = await this.projectSettingsService.get(projectId, userId)

    // GA4 Data API doesn't accept a per-query timezone — `dateHour` is rendered
    // in the *property's* configured timezone (GA Admin → Property settings).
    // If property tz === user tz, bars align like PostHog. Otherwise GA bars
    // in daily mode will be off by the offset between the two zones. Logged
    // here so the gap is observable in production. Full fix = switch to a
    // timestamp dimension + bucket on the backend (out of scope, see plan).
    if (tz !== 'UTC' && provider?.type === 'google_analytics') {
      this.logger.warn(
        `GA traffic with tz=${tz}: GA's dateHour is property-tz; chart may be misaligned if property tz !== user tz`,
      )
    }

    const ctx: ChartFetchContext = {
      userId,
      projectId,
      dateFrom,
      dateTo,
      gran,
      tz,
      provider,
      projectSettings,
      buckets,
    }

    // Accumulators keyed by bucket index — mutated in place by the two
    // metric helpers below.
    const byBucketTotal: number[] = new Array(buckets.length).fill(0)
    const byBucketSources: BucketSourceMap[] = buckets.map(() => new Map())
    const bySecondary: (number | null)[] = new Array(buckets.length).fill(null)

    const { unavailable: primaryUnavailable } = await this.accumulatePrimaryMetric(
      ctx,
      primaryMetric,
      byBucketTotal,
      byBucketSources,
    )
    const { unavailable: secondaryUnavailable, total: totalSecondary } =
      await this.accumulateSecondaryMetric(ctx, secondaryMetric, bySecondary)

    // Unique-visitor totals must be DEDUPED across the whole range, not
    // summed from the per-bucket bars. The bars hold per-bucket distinct
    // people (a legit per-hour/day stat), but summing them double-counts
    // anyone active in multiple buckets — which is how the headline
    // "Visitors" total could read higher than the pageview count and
    // disagree with the (deduped) sources panel. Fetch the honest
    // range-wide distinct count and override the summed total. Only for
    // `visitors`; pageviews/conversions/revenue sum correctly.
    const totalPrimaryOverride =
      primaryMetric === 'visitors' && !primaryUnavailable
        ? await this.fetchVisitorsTotal(ctx)
        : undefined

    return this.buildChartResponse({
      buckets,
      byBucketTotal,
      byBucketSources,
      bySecondary,
      totalSecondary,
      totalPrimaryOverride,
      primaryUnavailable,
      secondaryUnavailable,
      provider,
    })
  }

  /**
   * Visitors / pageviews / conversions / revenue → fill the per-bucket
   * `total` and `sources` accumulators. Returns `unavailable: true`
   * when the required connection is missing or the upstream fetch
   * threw (we degrade rather than failing the whole chart — the
   * secondary metric should still render).
   */
  private async accumulatePrimaryMetric(
    ctx: ChartFetchContext,
    primaryMetric: PrimaryMetric,
    byBucketTotal: number[],
    byBucketSources: BucketSourceMap[],
  ): Promise<{ unavailable: boolean }> {
    const { provider, projectSettings, dateFrom, dateTo, gran, tz, buckets } = ctx

    if (primaryMetric === 'visitors' || primaryMetric === 'pageviews') {
      if (!provider) return { unavailable: true }
      if (provider.type === 'google_analytics') {
        try {
          const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
          const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
          const gaClient = new GoogleAnalyticsDataClient(token, provider.connectionId)
          if (primaryMetric === 'visitors') {
            const rows = await gaClient.fetchSourcesByBucket(propertyId, dateFrom, dateTo, gran)
            this.assignSourceRows(buckets, byBucketTotal, byBucketSources, rows)
          } else {
            const rows = await gaClient.fetchMetricByBucket(
              propertyId,
              'screenPageViews',
              dateFrom,
              dateTo,
              gran,
            )
            this.assignFlatRows(buckets, byBucketTotal, byBucketSources, rows, 'Total')
          }
          return { unavailable: false }
        } catch (err) {
          this.logger.warn(`GA fetch failed: ${String(err)}`)
          return { unavailable: true }
        }
      }
      // PostHog — the metric decides the aggregation: 'visitors'
      // counts DISTINCT people, 'pageviews' counts raw $pageview
      // events. These used to be the same query (count()), which is
      // why the chart's "Visitors" never matched PostHog's own
      // unique-visitor numbers.
      try {
        const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
        if (!ph) return { unavailable: true }
        const rows = await fetchPosthogSourcesByBucket(
          new PosthogApiClient(ph),
          dateFrom,
          dateTo,
          gran,
          this.logger,
          tz,
          primaryMetric === 'visitors' ? 'visitors' : 'pageviews',
        )
        this.assignSourceRows(buckets, byBucketTotal, byBucketSources, rows, 'posthog')
        return { unavailable: false }
      } catch (err) {
        this.logger.warn(`PostHog fetch failed: ${String(err)}`)
        return { unavailable: true }
      }
    }

    if (primaryMetric === 'conversions') {
      if (!projectSettings.conversionConnectionId || !projectSettings.conversionEvent) {
        return { unavailable: true }
      }
      try {
        const ph = await getPosthogCredentials(projectSettings.conversionConnectionId, this.posthogCredentialsService)
        if (!ph) return { unavailable: true }
        const rows = await fetchPosthogEventCountByBucket(
          new PosthogApiClient(ph),
          projectSettings.conversionEvent,
          dateFrom,
          dateTo,
          gran,
          this.logger,
          tz,
        )
        this.assignFlatRows(buckets, byBucketTotal, byBucketSources, rows, 'Conversions')
        return { unavailable: false }
      } catch (err) {
        this.logger.warn(`Conversions fetch failed: ${String(err)}`)
        return { unavailable: true }
      }
    }

    // revenue — Stripe charges aggregated per bucket. The unique
    // wrinkle vs. visitors/conversions is the cents-to-dollars
    // conversion and the synthetic "Revenue" source row.
    try {
      const amounts = await this.fetchStripeRevenueForProject(ctx.userId, ctx.projectId, dateFrom, dateTo, gran)
      const byUnix = new Map(amounts.map(a => [a.bucketUnix, a.value]))
      for (let i = 0; i < buckets.length; i++) {
        const cents = byUnix.get(buckets[i].unix) ?? 0
        const dollars = cents / 100
        if (dollars > 0) {
          byBucketTotal[i] += dollars
          byBucketSources[i].set('revenue', { label: 'Revenue', color: '#635bff', value: dollars })
        }
      }
      return { unavailable: false }
    } catch (err) {
      this.logger.warn(`Stripe revenue fetch failed: ${String(err)}`)
      return { unavailable: true }
    }
  }

  /**
   * Secondary line series — revenue / bounce / avg-session / conversion-rate.
   * Fills `bySecondary` (one entry per bucket, `null` when there's no data
   * for that bucket) and returns the aggregate total for the period.
   */
  private async accumulateSecondaryMetric(
    ctx: ChartFetchContext,
    secondaryMetric: SecondaryMetric,
    bySecondary: (number | null)[],
  ): Promise<{ unavailable: boolean; total: number | null }> {
    if (secondaryMetric == null) return { unavailable: false, total: null }
    const { provider, projectSettings, dateFrom, dateTo, gran, tz, buckets } = ctx

    if (secondaryMetric === 'revenue') {
      try {
        const amounts = await this.fetchStripeRevenueForProject(ctx.userId, ctx.projectId, dateFrom, dateTo, gran)
        const byUnix = new Map(amounts.map(a => [a.bucketUnix, a.value]))
        let sum = 0
        for (let i = 0; i < buckets.length; i++) {
          const dollars = (byUnix.get(buckets[i].unix) ?? 0) / 100
          bySecondary[i] = dollars
          sum += dollars
        }
        return { unavailable: false, total: sum }
      } catch {
        return { unavailable: true, total: null }
      }
    }

    if (secondaryMetric === 'bounce_rate' || secondaryMetric === 'avg_session_sec') {
      if (provider?.type !== 'google_analytics') return { unavailable: true, total: null }
      try {
        const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
        const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
        const metric = secondaryMetric === 'bounce_rate' ? 'bounceRate' : 'averageSessionDuration'
        const rows = await new GoogleAnalyticsDataClient(token, provider.connectionId).fetchMetricByBucket(
          propertyId,
          metric,
          dateFrom,
          dateTo,
          gran,
        )
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
        return { unavailable: false, total: count > 0 ? sum / count : null }
      } catch {
        return { unavailable: true, total: null }
      }
    }

    // conversion_rate — needs both the traffic provider (denominator =
    // sessions) and the conversion-event PostHog connection (numerator =
    // event count).
    if (!provider || !projectSettings.conversionConnectionId || !projectSettings.conversionEvent) {
      return { unavailable: true, total: null }
    }
    try {
      const sessionsByKey = await this.fetchSessionsByBucket(provider, dateFrom, dateTo, gran, tz)
      const conversionsByKey = await this.fetchConversionsByBucket(
        projectSettings.conversionConnectionId,
        projectSettings.conversionEvent,
        dateFrom,
        dateTo,
        gran,
        tz,
      )

      let totalConv = 0
      let totalSess = 0
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i]
        const sessKey =
          provider.type === 'google_analytics' ? b.gaKey : gran === 'hourly' ? b.phHourlyKey : b.phDailyKey
        const convKey = gran === 'hourly' ? b.phHourlyKey : b.phDailyKey
        const sess = sessionsByKey.get(sessKey) ?? 0
        const conv = conversionsByKey.get(convKey) ?? 0
        totalConv += conv
        totalSess += sess
        bySecondary[i] = sess > 0 ? (conv / sess) * 100 : null
      }
      return { unavailable: false, total: totalSess > 0 ? (totalConv / totalSess) * 100 : null }
    } catch {
      return { unavailable: true, total: null }
    }
  }

  /** Sessions per bucket from the traffic provider — used for
   *  conversion_rate's denominator. GA returns `sessions` directly;
   *  PostHog gives us per-source counts that we sum. */
  private async fetchSessionsByBucket(
    provider: TrafficProvider,
    dateFrom: string,
    dateTo: string,
    gran: BucketGranularity,
    tz: string,
  ): Promise<Map<string, number>> {
    if (provider.type === 'google_analytics') {
      const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
      const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
      const rows = await new GoogleAnalyticsDataClient(token, provider.connectionId).fetchMetricByBucket(
        propertyId,
        'sessions',
        dateFrom,
        dateTo,
        gran,
      )
      return new Map(rows.map(r => [r.bucketKey, r.value]))
    }
    const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
    if (!ph) return new Map()
    const rows = await fetchPosthogSourcesByBucket(new PosthogApiClient(ph), dateFrom, dateTo, gran, this.logger, tz)
    const out = new Map<string, number>()
    for (const r of rows) out.set(r.bucketKey, (out.get(r.bucketKey) ?? 0) + r.value)
    return out
  }

  /** Conversions per bucket from the configured PostHog connection. */
  private async fetchConversionsByBucket(
    connectionId: string,
    eventName: string,
    dateFrom: string,
    dateTo: string,
    gran: BucketGranularity,
    tz: string,
  ): Promise<Map<string, number>> {
    const ph = await getPosthogCredentials(connectionId, this.posthogCredentialsService)
    if (!ph) return new Map()
    const rows = await fetchPosthogEventCountByBucket(new PosthogApiClient(ph), eventName, dateFrom, dateTo, gran, this.logger, tz)
    return new Map(rows.map(r => [r.bucketKey, r.value]))
  }

  /**
   * Range-wide deduped unique-visitor count for the chart's headline
   * total (see the note at the `fetchChart` call site). Routes to the
   * active traffic provider. Returns `null` on a missing provider or
   * any upstream error so the caller falls back to the per-bucket sum
   * rather than wrongly showing "Total: 0" under populated bars.
   */
  private async fetchVisitorsTotal(ctx: ChartFetchContext): Promise<number | null> {
    const { provider, dateFrom, dateTo, tz } = ctx
    if (!provider) return null
    try {
      if (provider.type === 'google_analytics') {
        const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
        const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
        return await new GoogleAnalyticsDataClient(token, provider.connectionId).fetchVisitorsTotal(
          propertyId,
          dateFrom,
          dateTo,
        )
      }
      const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
      if (!ph) return null
      return await fetchPosthogVisitorsTotal(new PosthogApiClient(ph), dateFrom, dateTo, this.logger, tz)
    } catch (err) {
      this.logger.warn(`visitors-total fetch failed: ${String(err)}`)
      return null
    }
  }

  /** Final assembly: stitch the bucket grid + accumulators into the
   *  response shape the controller returns. Pure transform — no I/O. */
  private buildChartResponse(args: {
    buckets: Bucket[]
    byBucketTotal: number[]
    byBucketSources: BucketSourceMap[]
    bySecondary: (number | null)[]
    totalSecondary: number | null
    /** When set, replaces the summed primary total (see the deduped
     *  unique-visitor note in `fetchChart`). `null`/`undefined` →
     *  fall back to the bar sum. */
    totalPrimaryOverride?: number | null
    primaryUnavailable: boolean
    secondaryUnavailable: boolean
    provider: TrafficProvider | null
  }): OverviewChartResponse {
    const { buckets, byBucketTotal, byBucketSources, bySecondary, totalSecondary, totalPrimaryOverride, primaryUnavailable, secondaryUnavailable, provider } = args
    const outBuckets: OverviewBucket[] = buckets.map((b, i) => ({
      label: b.label,
      total: byBucketTotal[i],
      bySource: Array.from(byBucketSources[i].entries())
        .map(([key, v]) => ({ source: key, label: v.label, color: v.color, value: v.value }))
        .sort((a, b) => b.value - a.value),
      secondary: bySecondary[i],
    }))
    const totalPrimary = totalPrimaryOverride ?? byBucketTotal.reduce((a, b) => a + b, 0)
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
    tz: string = 'UTC',
  ): Promise<OverviewSourcesResponse> {
    this.logger.log(
      `\n  ► fetchSources  projectId=${projectId} ${dateFrom}→${dateTo}  limit=${limit} tz=${tz}`,
    )

    const provider = await this.pickTrafficProvider(userId, projectId)
    if (!provider) return { sources: [], provider: null }

    // Reuse the per-bucket fetchers; aggregate across buckets to a single source list.
    const gran: BucketGranularity = 'daily'
    let rows: { source: string; value: number }[] = []

    try {
      if (provider.type === 'google_analytics') {
        const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
        const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
        const all = await new GoogleAnalyticsDataClient(token, provider.connectionId).fetchSourcesByBucket(
          propertyId,
          dateFrom,
          dateTo,
          gran,
        )
        rows = all.map(r => ({ source: r.source, value: r.value }))
      } else {
        const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
        if (ph) {
          // 'visitors' + the user's tz. The tz used to be omitted
          // (defaulted to UTC) while the CHART bucketed in the
          // user's tz — so the panel and chart could disagree on
          // which events belong to "today" and their totals never
          // reconciled near midnight-adjacent hours.
          const all = await fetchPosthogSourcesByBucket(
            new PosthogApiClient(ph),
            dateFrom,
            dateTo,
            gran,
            this.logger,
            tz,
            'visitors',
          )
          rows = all.map(r => ({ source: r.source, value: r.value }))
        }
      }
    } catch (err) {
      this.logger.warn(`fetchSources provider error: ${String(err)}`)
      return { sources: [], provider: provider.type }
    }

    // Group + normalise.
    //
    // Recognised brands (google, twitter/x, reddit, …) keep their single
    // bucket via `n.key`. Unrecognised referrers, however, would all
    // collapse onto `key = 'other'` — losing the actual domain that drove
    // the traffic. Re-key those by the raw domain so each unique
    // unknown-referrer gets its own row (e.g. `tinylaunch.com`,
    // `producthunt.com`). The frontend's `sourceStyle()` lookup already
    // falls through to the label for keys it doesn't recognise, so the
    // "other:<domain>" prefix needs no UI-side icon-map work.
    //
    // Truly missing referrers still hit the `direct` rule (it matches
    // empty / "(direct)" / "(none)"), so direct visits stay grouped under
    // a single "Direct" row — they're not split into per-row blanks.
    const byKey = new Map<string, { label: string; color: string; value: number }>()
    for (const r of rows) {
      const n = normalizeSource(r.source)
      const groupKey =
        n.key === 'other'
          ? `other:${(r.source ?? '').trim().toLowerCase() || 'other'}`
          : n.key
      const existing = byKey.get(groupKey)
      if (existing) existing.value += r.value
      else byKey.set(groupKey, { label: n.label, color: n.color, value: r.value })
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

    return { sources: sorted, provider: provider.type }
  }

  /**
   * Per-user breakdown for the Users tab. Happy path = PostHog: one HogQL
   * query already aggregated at the person level. GA4 can expose similar
   * data via the `userPseudoId` dimension but session-duration and
   * first-source-per-user need non-trivial follow-up aggregations, so we
   * defer that and surface an empty response with `provider: 'google_analytics'`
   * so the frontend can show the right empty-state CTA.
   */
  async fetchUsers(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    limit = 100,
  ): Promise<OverviewUsersResponse> {
    this.logger.log(
      `\n  ► fetchUsers   projectId=${projectId} ${dateFrom}→${dateTo}  limit=${limit}`,
    )

    const provider = await this.pickTrafficProvider(userId, projectId)
    if (!provider) return { users: [], provider: null }

    // GA is deliberately unsupported in this pass — frontend renders a
    // dedicated "requires PostHog" empty state instead of a generic one so
    // the user understands why the tab is empty.
    if (provider.type === 'google_analytics') {
      return { users: [], provider: 'google_analytics' }
    }

    try {
      const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
      if (!ph) return { users: [], provider: 'posthog' }

      const rows = await fetchPosthogUsersList(new PosthogApiClient(ph), dateFrom, dateTo, limit, this.logger)
      const users: OverviewUser[] = rows.map(r => {
        const n = normalizeSource(r.source)
        return {
          pseudoId: r.pseudoId,
          source: n.key,
          label: n.label,
          color: n.color,
          sessionSec: r.sessionSec,
          lastSeen: r.lastSeen,
        }
      })
      return { users, provider: 'posthog' }
    } catch (err) {
      this.logger.warn(`fetchUsers PostHog error: ${String(err)}`)
      return { users: [], provider: 'posthog' }
    }
  }

  /**
   * Per-country visitor breakdown for the overview Countries tab.
   * Same provider routing as `fetchUsers` (PostHog only — GA support
   * deferred). `share` is precomputed server-side so the panel
   * doesn't have to recompute the denominator on every render.
   */
  async fetchCountries(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    limit = 50,
    tz: string = 'UTC',
  ): Promise<OverviewCountriesResponse> {
    this.logger.log(
      `\n  ► fetchCountries  projectId=${projectId} ${dateFrom}→${dateTo}  limit=${limit} tz=${tz}`,
    )

    const provider = await this.pickTrafficProvider(userId, projectId)
    if (!provider) return { countries: [], provider: null }
    if (provider.type === 'google_analytics') {
      // GA exposes geoip via `country` dimension but the panel uses
      // ISO-2 codes for flag rendering; map-from-display-name is
      // ambiguous (UK vs GB, USA vs US, etc.). Deferred until we add
      // a GA-native countries query.
      return { countries: [], provider: 'google_analytics' }
    }

    try {
      const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
      if (!ph) return { countries: [], provider: 'posthog' }

      const rows = await fetchPosthogCountriesList(
        new PosthogApiClient(ph),
        dateFrom,
        dateTo,
        limit,
        this.logger,
        tz,
      )
      const totalVisitors = rows.reduce((sum, r) => sum + r.visitors, 0)
      const countries: OverviewCountry[] = rows.map(r => ({
        countryCode: r.countryCode,
        countryName: r.countryName,
        visitors: r.visitors,
        share: totalVisitors > 0 ? r.visitors / totalVisitors : 0,
      }))
      return { countries, provider: 'posthog' }
    } catch (err) {
      this.logger.warn(`fetchCountries PostHog error: ${String(err)}`)
      return { countries: [], provider: 'posthog' }
    }
  }

  /**
   * Top pages by pageview count — the overview panel's "Pages" tab.
   * `pageviews` is the headline (how many pages were viewed, no
   * matter by whom); `visitors` rides along so the row can show the
   * unique-people count too. `share` is pageview-based.
   */
  async fetchPages(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    limit = 50,
    tz: string = 'UTC',
  ): Promise<OverviewPagesResponse> {
    this.logger.log(
      `\n  ► fetchPages  projectId=${projectId} ${dateFrom}→${dateTo}  limit=${limit} tz=${tz}`,
    )

    const provider = await this.pickTrafficProvider(userId, projectId)
    if (!provider) return { pages: [], provider: null }

    let rows: { path: string; pageviews: number; visitors: number }[] = []
    try {
      if (provider.type === 'google_analytics') {
        const token = await this.gaOAuthService.ensureFreshToken(provider.connectionId)
        const propertyId = await this.gaOAuthService.getPropertyId(provider.connectionId)
        rows = await new GoogleAnalyticsDataClient(token, provider.connectionId).fetchPagesList(
          propertyId,
          dateFrom,
          dateTo,
          limit,
        )
      } else {
        const ph = await getPosthogCredentials(provider.connectionId, this.posthogCredentialsService)
        if (!ph) return { pages: [], provider: 'posthog' }
        rows = await fetchPosthogPagesList(new PosthogApiClient(ph), dateFrom, dateTo, limit, this.logger, tz)
      }
    } catch (err) {
      this.logger.warn(`fetchPages provider error: ${String(err)}`)
      return { pages: [], provider: provider.type }
    }

    const totalPageviews = rows.reduce((sum, r) => sum + r.pageviews, 0)
    const pages: OverviewPage[] = rows.map(r => ({
      path: r.path,
      pageviews: r.pageviews,
      visitors: r.visitors,
      share: totalPageviews > 0 ? r.pageviews / totalPageviews : 0,
    }))
    return { pages, provider: provider.type }
  }

  async listConversionEvents(
    userId: string,
    connectionId: string,
  ): Promise<{ events: { name: string }[] }> {
    // Verify ownership
    const { data: conn } = await this.connectionsRepository.findIdAndTypeByIdAndUserId(
      connectionId,
      userId,
    )
    if (!conn) return { events: [] }

    if (conn.type === 'posthog') {
      const ph = await getPosthogCredentials(connectionId, this.posthogCredentialsService)
      if (!ph) return { events: [] }
      const names = await listPosthogEventNames(new PosthogApiClient(ph), this.logger)
      return { events: names.map(name => ({ name })) }
    }

    // GA event names are a property — we don't enumerate them for now.
    // Users targeting GA can type their event name manually in settings (v2 enhancement).
    return { events: [] }
  }

  /**
   * Helper: sum stripe revenue across every Stripe connection (manual or
   * Connect) eligible for this project. "Eligible" = `project_id = :projectId`
   * OR `project_id IS NULL` (Common, shared across all projects).
   *
   * NOTE on the Common include (unlike `pickTrafficProvider` which now
   * excludes Common): Stripe doesn't have the per-domain mixing problem
   * that the traffic providers do — Stripe charges are inherently
   * account-scoped (one Stripe account = one set of charges), and the
   * per-account dedup below (`accountsCoveredUnfiltered`) keeps two
   * Common-scoped connections pointing at the same Stripe account from
   * double-counting. More importantly, the per-tile Stripe views
   * (`stripe_gross`, `stripe_gross_today`, MRR, Top Customers) fetch
   * via `connection_id` directly and ignore project scoping entirely —
   * if we filtered Common out HERE, the overview chart's revenue line
   * would silently disagree with every Stripe tile sitting next to it
   * on the same project page ($0 chart vs $1,781 tile). Matching the
   * tile behaviour wins over strict scoping for Stripe; users who
   * want strict per-project Stripe revenue can split a single account
   * into multiple connections with product filters (the storage layer
   * already supports that — see comment below).
   *
   * Reads from Supabase (`stripe_charges` + optionally `stripe_line_items`),
   * NOT the live Stripe API. Each eligible connection's per-connection
   * product filter is honoured — two connections for the same Stripe account
   * filtered to different product subsets contribute different amounts to
   * the same project (sum of both is the project's total). Two connections
   * pointing at the same account with NO product filter produce duplicate
   * rows for every charge — to avoid this, we dedup by `stripe_account_id`
   * within the unfiltered set: only the first unfiltered connection per
   * account contributes its rows. Filtered connections always contribute.
   */
  private async fetchStripeRevenueForProject(
    userId: string,
    projectId: string,
    dateFrom: string,
    dateTo: string,
    gran: BucketGranularity,
  ): Promise<{ bucketUnix: number; value: number }[]> {
    const { data: conns } = await this.connectionsRepository.findStripeConnectionsForProject(
      userId,
      projectId,
    )

    if (!conns || conns.length === 0) return []

    const merged = new Map<number, number>()
    const accountsCoveredUnfiltered = new Set<string>()

    for (const c of conns) {
      try {
        const accountId = await getStripeAccountIdForConnection(
          this.connectionsRepository,
          c.id as string,
        )
        if (!accountId) continue

        const productFilter = await getConnectionProductFilter(
          this.connectionsRepository,
          c.id as string,
        )

        if (productFilter.length === 0) {
          // Unfiltered = "all products". Avoid double-counting if two
          // unfiltered connections cover the same account.
          if (accountsCoveredUnfiltered.has(accountId)) continue
          accountsCoveredUnfiltered.add(accountId)
        }

        const rows = await fetchStripeRevenueByBucketFromStorage(
          this.stripeRepository,
          accountId,
          dateFrom,
          dateTo,
          gran,
          productFilter,
        )

        for (const r of rows) {
          merged.set(r.bucketUnix, (merged.get(r.bucketUnix) ?? 0) + r.value)
        }
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
   *
   * Keying rule (must mirror `fetchSources`):
   *   - Known integrations (`x`, `google`, `reddit`, …) use the
   *     normalized key verbatim.
   *   - The `'other'` catch-all is re-keyed PER DOMAIN as
   *     `other:<lowercased-raw-source>` so each unknown referrer
   *     becomes its own segment instead of being summed into a single
   *     opaque "other" bar.
   *
   * Why this matters: the frontend's `assignChartColors` ranks
   * source keys by total value to pick the red→orange→yellow palette
   * (biggest = red). If every unknown collapsed into one `'other'`
   * key, the chart would compare `'other'` (= sum of every unknown
   * domain) against individual brand keys like `'x'` — and end up
   * showing `x.com` as red while the actual biggest source (e.g.
   * `tinylaunch.com`, hiding inside the merged `'other'` totals)
   * rendered as a generic grey segment. The sources panel already
   * re-keys per domain (see `fetchSources`), so the panel + chart
   * disagreed about which source deserved which colour.
   *
   * The `'unset'` key (for GA's `(not set)` / PostHog `Not set`
   * sentinels) is deliberately NOT split per domain — those are all
   * "we don't know where this came from", and lumping them under a
   * single row matches `normalizeSource`'s own contract.
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
      // Per-domain split for the `other` catch-all (see docstring).
      const groupKey =
        n.key === 'other'
          ? `other:${(r.source ?? '').trim().toLowerCase() || 'other'}`
          : n.key
      totals[idx] += r.value
      const existing = sources[idx].get(groupKey)
      if (existing) existing.value += r.value
      else sources[idx].set(groupKey, { label: n.label, color: n.color, value: r.value })
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
