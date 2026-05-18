import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ViewsService } from '../../views/views.service'
import { ConnectionMissingException } from '../../common/integration-errors'
import { buildViewFetchContext } from '../../common/view-fetch-context'
import {
  fetchAccountCharges,
  fetchActiveSubsAndMrr,
  fetchChurnRate30d,
  fetchTopCustomers,
  getConnectionProductFilter,
  getStripeAccountIdForConnection,
  type ChargeRow,
  type TopCustomerRow,
} from './storage-queries'
import type { ChartPoint } from './stripe-api.helpers'
import { hourInTz, hourlyBucketCount } from '../../common/tz'

/**
 * View types backed by `fetchLiveValue`. Centralised so the dispatch check
 * and any future registry can share one source of truth.
 *
 * `stripe_top_customers` is intentionally NOT here — it returns a list, not
 * a string, and rides its own controller route + service method.
 *
 * `stripe_revenue_today` was merged into `stripe_gross` (the polymorphic
 * type that also serves the chart variant via `fetchChartData`). For the
 * value-mode flavour, the frontend sends `stripe_gross` and the backend
 * sums charges over the requested date range — same numeric output as the
 * old `stripe_revenue_today`. See `migrate-view-types-2026-05.ts` for the
 * one-shot DB rewrite that turned old rows into `stripe_gross + config.
 * displayMode='value'`.
 */
const LIVE_VALUE_TYPES = new Set([
  'stripe_gross_today',
  'stripe_gross',
  'stripe_mrr',
  'stripe_active_subs',
  'stripe_churn_rate',
])

type ChartMode = 'daily' | 'weekly' | 'monthly'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Stripe view endpoints — Supabase-backed read layer. The actual Stripe API
 * is only touched at backfill / webhook / nightly-reconcile time; everything
 * users see is computed from `stripe_charges` (+ `stripe_line_items` when a
 * connection has a product filter active).
 *
 * Connection ownership: this service still verifies the connection belongs
 * to `userId` before doing any reads (via `getStripeAccountIdForConnection`'s
 * upstream connection lookup), so leaking another user's account ID is not
 * possible.
 */
@Injectable()
export class StripeViewsService {
  private readonly logger = new Logger(StripeViewsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
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
    const ctx = buildViewFetchContext(dateFrom, dateTo, tz)
    const { from, to, isSingleDay } = ctx

    this.logger.log(
      `fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}  tz=${ctx.tz}`,
    )

    if (!LIVE_VALUE_TYPES.has(viewType)) {
      throw new NotFoundException(`Unknown live view type: ${viewType}`)
    }

    // SaaS-metric tiles read `stripe_subscriptions` directly — no charge-set
    // bucketing. Date range is ignored (MRR/active/churn are point-in-time).
    if (
      viewType === 'stripe_mrr' ||
      viewType === 'stripe_active_subs' ||
      viewType === 'stripe_churn_rate'
    ) {
      return this.fetchSubscriptionMetric(connectionId, viewType, userId, from)
    }

    const { rows, accountId } = await this.fetchChargesForConnection(
      connectionId,
      userId,
      from,
      to,
      tz,
    )

    if (!accountId) {
      // Connection exists but isn't a Stripe one (or the account hasn't been
      // linked yet). Surface as unavailable rather than throwing — the
      // frontend renders an empty tile, not an error toast.
      return { value: null, unavailable: true }
    }

    const total = rows.reduce((sum, r) => sum + r.amount, 0)
    const value = String(total)

    if (isSingleDay) {
      // Keep the views_values cache layer happy for cross-provider single-day
      // tiles. Reads still come from Supabase, so this is purely so the
      // existing scheduler / counters don't see a missing row.
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`fetchLiveValue → ${value}`)
    return { value }
  }

  /**
   * Subscription-backed tiles (MRR, active subs, churn). Branched out of
   * `fetchLiveValue` because they share an account+filter resolution path
   * but read different storage. All three are point-in-time — date range
   * is intentionally not threaded through.
   *
   * Wire shape stays `{ value: string | null, unavailable?: true }` for
   * frontend consistency. Format conventions:
   *   - mrr:         cents-string ("12345" = $123.45)
   *   - active_subs: integer-string ("17")
   *   - churn_rate:  one-decimal percent string ("4.2")  — frontend appends '%'
   */
  private async fetchSubscriptionMetric(
    connectionId: string,
    viewType: 'stripe_mrr' | 'stripe_active_subs' | 'stripe_churn_rate',
    userId: string,
    cacheDate: string,
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const client = this.supabaseService.getClient()

    const { data: conn } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) throw new ConnectionMissingException('stripe', connectionId)

    const accountId = await getStripeAccountIdForConnection(client, connectionId)
    if (!accountId) return { value: null, unavailable: true }

    let value: string

    if (viewType === 'stripe_churn_rate') {
      // v1 limitation: ignores the per-connection product filter. Documented
      // in `fetchChurnRate30d`'s docstring.
      const { churnRate } = await fetchChurnRate30d(client, accountId)
      value = (churnRate * 100).toFixed(1)
    } else {
      const productFilter = await getConnectionProductFilter(client, connectionId)
      const { activeSubs, mrrCents } = await fetchActiveSubsAndMrr(
        client,
        accountId,
        productFilter,
      )
      value = viewType === 'stripe_mrr' ? String(mrrCents) : String(activeSubs)
    }

    // Cache for cross-provider single-value tiles. The metric is
    // point-in-time, but the cache key is per-day so it dovetails with the
    // existing scheduler infrastructure.
    await this.viewsService.upsertValue(connectionId, viewType, value, cacheDate)

    this.logger.log(`  ✓ fetchSubscriptionMetric → ${value}`)
    return { value }
  }

  /**
   * Top customers list — separate from `fetchLiveValue` because the wire
   * shape is `Array<TopCustomerRow>`, not a single string. Mirrors
   * `CalendlyViewsService.fetchMeetings` in spirit.
   */
  async fetchTopCustomers(
    connectionId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    tz: string = 'UTC',
  ): Promise<{ customers: TopCustomerRow[]; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from

    this.logger.log(
      `\n  ► fetchTopCustomers  connectionId=${connectionId}  ${from}→${to}  tz=${tz}`,
    )

    const client = this.supabaseService.getClient()

    const { data: conn } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) throw new ConnectionMissingException('stripe', connectionId)

    const accountId = await getStripeAccountIdForConnection(client, connectionId)
    if (!accountId) return { customers: [], unavailable: true }

    const productFilter = await getConnectionProductFilter(client, connectionId)
    const customers = await fetchTopCustomers(
      client,
      accountId,
      productFilter,
      from,
      to,
      10,
      tz,
    )

    this.logger.log(`  ✓ fetchTopCustomers → ${customers.length} customer(s)`)
    return { customers }
  }

  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    mode?: ChartMode,
    tz: string = 'UTC',
  ): Promise<ChartPoint[]> {
    this.logger.log(
      `\n  ► fetchChartData  connectionId=${connectionId}  viewType=${viewType}  ${dateFrom ?? '?'}→${dateTo ?? '?'}  mode=${mode ?? '?'}  tz=${tz}`,
    )

    if (viewType === 'stripe_gross_today') {
      const today = new Date().toISOString().split('T')[0]
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, today, today, tz)
      return bucketByHour(rows, today, /* truncateAtNow= */ true, tz)
    }

    if (viewType === 'stripe_gross_week') {
      const { from, to } = thisWeekRange()
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, from, to, tz)
      return bucketByDayLabels(rows, from, to)
    }

    if (viewType === 'stripe_gross') {
      const todayStr = new Date().toISOString().split('T')[0]
      const from = dateFrom ?? todayStr
      const to = dateTo ?? from
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, from, to, tz)

      if (mode === 'daily' || (!mode && from === to)) {
        const truncate = from === todayStr
        return bucketByHour(rows, from, truncate, tz)
      }
      // Monthly mode buckets to ~5 weekly bars (labelled "May 1", "May 8"
      // …) instead of 30-something day labels — those collapsed into an
      // unreadable "Fri Sun Thu Wed Mon Tue Wed…" mush on a chart that's
      // only ~600px wide. `weekly` still falls through to the per-day
      // labels below (7 bars, one per weekday — readable on a week
      // range).
      if (mode === 'monthly') {
        return bucketByWeek(rows, from, to)
      }
      return bucketByDayLabels(rows, from, to)
    }

    throw new NotFoundException(`No chart data for view type: ${viewType}`)
  }

  /**
   * Verify the connection belongs to the user, resolve its stripe_account_id,
   * apply the per-connection product filter, and pull charges. Returns rows
   * shaped for downstream bucketing.
   *
   * Returns `{ rows: [], accountId: null }` for a non-Stripe / unlinked
   * connection so callers can render an "unavailable" empty state.
   */
  private async fetchChargesForConnection(
    connectionId: string,
    userId: string,
    dateFrom: string,
    dateTo: string,
    tz: string = 'UTC',
  ): Promise<{ rows: ChargeRow[]; accountId: string | null }> {
    const client = this.supabaseService.getClient()

    // Ownership check — same pattern as the old `getApiKey` helper.
    const { data: conn } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    // 410 (not 404) so the frontend can route this into the inline
    // reassign-connection dialog instead of the generic error badge — the
    // view's `connection_id` FK is dangling, not absent.
    if (!conn) throw new ConnectionMissingException('stripe', connectionId)

    const accountId = await getStripeAccountIdForConnection(client, connectionId)
    if (!accountId) return { rows: [], accountId: null }

    const productFilter = await getConnectionProductFilter(client, connectionId)
    const rows = await fetchAccountCharges(
      client,
      accountId,
      dateFrom,
      dateTo,
      productFilter,
      tz,
    )

    return { rows, accountId }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bucket-stitching helpers — operate on the same `ChargeRow` shape regardless
// of whether the rows came from the unfiltered fast path or the line-item
// filter path. Mirrors the legacy `live/*.ts` outputs (same labels, same
// truncation behaviour) so the frontend is unchanged.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bucket charges into 24 hourly bars labelled `12am`/`1am`/.../`11pm`.
 * Hours, "today" detection, and the right-edge truncation all key off
 * the user's `tz` — so a user in Europe/Bucharest at 23:40 local sees
 * the chart extend to "11pm" with the late-night charges counted,
 * instead of getting clipped at "8pm" (= UTC's current hour). The
 * previous UTC-based implementation silently dropped any charges in
 * the trailing `userOffset` hours of the day.
 *
 * `truncateAtNow=false` is the path used by historical-day fetches —
 * past days always render the full 24 bars.
 */
function bucketByHour(rows: ChargeRow[], dateStr: string, truncateAtNow: boolean, tz: string): ChartPoint[] {
  const hoursInBucket = truncateAtNow ? hourlyBucketCount(dateStr, tz) : 24

  const buckets = new Array<number>(hoursInBucket).fill(0)
  for (const r of rows) {
    const hour = hourInTz(new Date(r.created), tz)
    if (hour < hoursInBucket) buckets[hour] += r.amount
  }
  return buckets.map((value, h) => ({ label: fmtHour(h), value }))
}

function fmtHour(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function bucketByDayLabels(rows: ChargeRow[], dateFrom: string, dateTo: string): ChartPoint[] {
  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end = new Date(`${dateTo}T00:00:00Z`)
  const numDays =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1

  const buckets = new Array<number>(numDays).fill(0)
  for (const r of rows) {
    const d = new Date(r.created)
    const dayIndex = Math.floor(
      (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) /
        (1000 * 60 * 60 * 24),
    )
    if (dayIndex >= 0 && dayIndex < numDays) buckets[dayIndex] += r.amount
  }

  return buckets.map((value, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return { label: DAY_LABELS[d.getUTCDay()], value }
  })
}

/**
 * Bucket charges into weekly bars for monthly mode. Week boundaries
 * anchor at `dateFrom` — i.e. May 1–31 splits as [May 1–7, May 8–14,
 * May 15–21, May 22–28, May 29–31] rather than aligning to ISO weeks
 * (Mon-Sun). Anchoring at `dateFrom` keeps the bar count predictable
 * (`Math.ceil(numDays / 7)` = 4 or 5) regardless of which weekday the
 * month starts on.
 *
 * Labels are RANGES (`"May 1 – 7"`, `"May 22 – 28"`) so a user reading
 * the chart understands "this bar is a week's worth of activity" — the
 * previous single-date labels (`"May 15"`) read as "a payment on May 15"
 * and got flagged for confusion. When a week straddles a month boundary
 * the end side spells out the month (`"Apr 28 – May 4"`) so it's
 * unambiguous; same-month weeks use the compact form.
 *
 * The last bucket can be partial — for May 2026 (31 days) the May
 * 29–31 bar covers 3 days. The label honours the actual end (capped at
 * `dateTo`), not start+6 — so the user sees the true window, never a
 * label promising days that aren't there.
 */
function bucketByWeek(rows: ChargeRow[], dateFrom: string, dateTo: string): ChartPoint[] {
  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end = new Date(`${dateTo}T00:00:00Z`)
  const numDays =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const numWeeks = Math.max(1, Math.ceil(numDays / 7))

  const buckets = new Array<number>(numWeeks).fill(0)
  for (const r of rows) {
    const d = new Date(r.created)
    const dayIndex = Math.floor(
      (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) /
        (1000 * 60 * 60 * 24),
    )
    if (dayIndex < 0 || dayIndex >= numDays) continue
    const weekIndex = Math.floor(dayIndex / 7)
    buckets[weekIndex] += r.amount
  }

  return buckets.map((value, w) => {
    const bucketStart = new Date(start)
    bucketStart.setUTCDate(start.getUTCDate() + w * 7)
    // End = start + 6 days, but clamp to `end` so the LAST (partial)
    // week reads "May 29 – 31" instead of falsely promising "May 29 – Jun 4".
    const naiveEnd = new Date(bucketStart)
    naiveEnd.setUTCDate(bucketStart.getUTCDate() + 6)
    const bucketEnd = naiveEnd.getTime() > end.getTime() ? end : naiveEnd

    const sameMonth = bucketStart.getUTCMonth() === bucketEnd.getUTCMonth()
    const startLabel = `${MONTH_LABELS[bucketStart.getUTCMonth()]} ${bucketStart.getUTCDate()}`
    const endLabel = sameMonth
      ? String(bucketEnd.getUTCDate())
      : `${MONTH_LABELS[bucketEnd.getUTCMonth()]} ${bucketEnd.getUTCDate()}`
    // En-dash (–) rather than hyphen (-) reads better in number-range
    // labels at small font sizes. Matches the typographic convention
    // used elsewhere in the app's date headers.
    return { label: `${startLabel} – ${endLabel}`, value }
  })
}

function thisWeekRange(): { from: string; to: string } {
  const now = new Date()
  const day = now.getUTCDay()
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday)
  monday.setUTCHours(0, 0, 0, 0)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  return { from: fmt(monday), to: fmt(today) }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
