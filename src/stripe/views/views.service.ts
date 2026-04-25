import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ViewsService } from '../../views/views.service'
import {
  fetchAccountCharges,
  getConnectionProductFilter,
  getStripeAccountIdForConnection,
  type ChargeRow,
} from './storage-queries'
import type { ChartPoint } from './stripe-api.helpers'

type ChartMode = 'daily' | 'weekly' | 'monthly'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from

    this.logger.log(
      `\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}`,
    )

    if (
      viewType !== 'stripe_revenue_today' &&
      viewType !== 'stripe_gross_today' &&
      viewType !== 'stripe_gross'
    ) {
      throw new NotFoundException(`Unknown live view type: ${viewType}`)
    }

    const { rows, accountId } = await this.fetchChargesForConnection(
      connectionId,
      userId,
      from,
      to,
    )

    if (!accountId) {
      // Connection exists but isn't a Stripe one (or the account hasn't been
      // linked yet). Surface as unavailable rather than throwing — the
      // frontend renders an empty tile, not an error toast.
      return { value: null, unavailable: true }
    }

    const total = rows.reduce((sum, r) => sum + r.amount, 0)
    const value = String(total)

    if (from === to) {
      // Keep the views_values cache layer happy for cross-provider single-day
      // tiles. Reads still come from Supabase, so this is purely so the
      // existing scheduler / counters don't see a missing row.
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return { value }
  }

  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    mode?: ChartMode,
  ): Promise<ChartPoint[]> {
    this.logger.log(
      `\n  ► fetchChartData  connectionId=${connectionId}  viewType=${viewType}  ${dateFrom ?? '?'}→${dateTo ?? '?'}  mode=${mode ?? '?'}`,
    )

    if (viewType === 'stripe_gross_today') {
      const today = new Date().toISOString().split('T')[0]
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, today, today)
      return bucketByHour(rows, today, /* truncateAtNow= */ true)
    }

    if (viewType === 'stripe_gross_week') {
      const { from, to } = thisWeekRange()
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, from, to)
      return bucketByDayLabels(rows, from, to)
    }

    if (viewType === 'stripe_gross') {
      const todayStr = new Date().toISOString().split('T')[0]
      const from = dateFrom ?? todayStr
      const to = dateTo ?? from
      const { rows } = await this.fetchChargesForConnection(connectionId, userId, from, to)

      if (mode === 'daily' || (!mode && from === to)) {
        const truncate = from === todayStr
        return bucketByHour(rows, from, truncate)
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
  ): Promise<{ rows: ChargeRow[]; accountId: string | null }> {
    const client = this.supabaseService.getClient()

    // Ownership check — same pattern as the old `getApiKey` helper.
    const { data: conn } = await client
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!conn) throw new NotFoundException('Connection not found')

    const accountId = await getStripeAccountIdForConnection(client, connectionId)
    if (!accountId) return { rows: [], accountId: null }

    const productFilter = await getConnectionProductFilter(client, connectionId)
    const rows = await fetchAccountCharges(client, accountId, dateFrom, dateTo, productFilter)

    return { rows, accountId }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bucket-stitching helpers — operate on the same `ChargeRow` shape regardless
// of whether the rows came from the unfiltered fast path or the line-item
// filter path. Mirrors the legacy `live/*.ts` outputs (same labels, same
// truncation behaviour) so the frontend is unchanged.
// ────────────────────────────────────────────────────────────────────────────

function bucketByHour(rows: ChargeRow[], dateStr: string, truncateAtNow: boolean): ChartPoint[] {
  const todayStartUtc = new Date()
  todayStartUtc.setUTCHours(0, 0, 0, 0)
  const isToday = dateStr === todayStartUtc.toISOString().split('T')[0]
  const hoursInBucket = truncateAtNow && isToday ? new Date().getUTCHours() + 1 : 24

  const buckets = new Array<number>(hoursInBucket).fill(0)
  for (const r of rows) {
    const hour = new Date(r.created).getUTCHours()
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
