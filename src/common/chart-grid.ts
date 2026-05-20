/**
 * Canonical chart-data primitives.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * Today every chart-data endpoint in the app returns its own bespoke
 * shape: PostHog HogQL produces `'2026-05-19T14:00:00'` string keys
 * and only emits buckets where data exists. GA returns `'YYYYMMDDHH'`
 * keys in PROPERTY-tz with all 24 hours always present. Stripe ships
 * pre-formatted human labels (`'May 1 – 7'`, `'Fri'`, `'2pm'`) keyed
 * by display string. Project-overview returns `{ buckets: [{label,
 * total, bySource, secondary}] }` with its own internal alignment.
 *
 * Five different bucketing conventions across one app, none of them
 * cross-compatible. The result is that **the frontend can't easily
 * overlay two metrics from different sources on the same chart** —
 * the X axes don't share a keyspace. Today this is masked because
 * the project-overview endpoint resolves both axes server-side, but
 * it limits us to the predefined metric set.
 *
 * This file establishes ONE canonical bucket grid + ONE response
 * shape. Every chart-data endpoint will (over phases 3.0b/c) migrate
 * to it. After migration:
 *
 *   - Frontend overlays N metrics by `bucketKey` join — three lines
 *     of merge code, no per-provider logic
 *   - Adding a new provider (Linear, GitHub stars, whatever) is a
 *     thin adapter that produces a `ChartSeries` — no frontend work
 *   - Bucket-boundary logic lives in ONE function (`buildBucketGrid`),
 *     not five — the recent tz-truncation bug across 4 sites could
 *     only have been wrong in one place
 *   - Caching becomes possible (`(bucketKey, metric, connectionId)`
 *     as a stable key — today every endpoint has bespoke keys)
 *
 * ── Phase status ────────────────────────────────────────────────────────
 *
 * Phase 3.0a (THIS FILE): types + grid + assigner, plus inline self-
 *   checks. Nothing else in the app uses it yet — purely additive.
 *
 * Phase 3.0b–c: migrate the four existing chart endpoints (GA first
 *   as the simplest, then Stripe, PostHog, project-overview).
 *
 * Phase 3.1: flexible cascade-dropdown UI on top of the canonical
 *   shape. The whole point of this refactor.
 */

import { dateStrInTz, fieldsInTz, localMidnightUtc, safeTzLiteral } from './tz'

/**
 * The set of bucket sizes we support. `mode` (daily/weekly/monthly)
 * in the date-range picker is a HIGHER-LEVEL concept than granularity
 * — `mode` describes the user's intent ("show me this week"), while
 * `granularity` describes the bucket size on the chart axis. They
 * relate but aren't 1:1:
 *
 *   - `mode='daily'`   → granularity 'hourly' (24 bars)
 *   - `mode='weekly'`  → granularity 'daily'  (7 bars)
 *   - `mode='monthly'` → granularity 'daily'  (30/31 bars) — default
 *     OR 'weekly' (~5 bars) — when the caller wants compact labels
 *     (e.g. Stripe Gross Volume's monthly view) to avoid 30 weekday
 *     labels collapsing into illegible mush on a small card
 *
 * The mapping isn't hardcoded — callers pass `granularity` explicitly,
 * and the convenience helper `defaultGranularityForMode` provides
 * the typical mapping for callers that want it.
 */
export type ChartGranularity = 'hourly' | 'daily' | 'weekly' | 'monthly'

/**
 * One row in the canonical grid. The grid is the OUTPUT of
 * `buildBucketGrid` — a deterministic array of bucket descriptors
 * for a given (granularity, range, tz) tuple. Provider data is
 * later assigned to the grid via `assignToGrid`.
 *
 * `bucketKey` is the machine-readable join key — stable across
 * regenerations of the same grid. `label` is the human-readable
 * X-axis string in the user's timezone. `bucketStartUnix` is the
 * universal sort key (UTC seconds at the bucket's start instant).
 *
 * Why three fields and not just `bucketKey + label`: a join (two
 * series with the same key) needs to compare keys, but a sort
 * (multiple series merged into a chart) needs a numeric key —
 * comparing ISO strings lexicographically works for hourly/daily
 * but not for weekly (a "2026-W21" / "2026-W22" lex comparison
 * happens to work; a "May 8 – 14" vs "May 1 – 7" doesn't).
 * Carrying the unix epoch sidesteps the issue cleanly.
 */
export interface BucketDescriptor {
  /** Canonical key in the form produced by `bucketKeyForStart`. */
  bucketKey: string
  /** UTC seconds at the bucket's start instant. */
  bucketStartUnix: number
  /** Human-readable X-axis label, formatted in the user's tz. */
  label: string
}

/**
 * One stack segment for metrics with a natural breakdown dimension
 * (e.g. visitors-by-source). When `breakdown` is omitted on a
 * bucket, the metric is single-valued (e.g. revenue, MRR).
 *
 * `key` is the join across buckets ("same source across the X
 * axis"). `label` + `color` are render hints — the chart can
 * either trust these (fast path) or look them up by `key` in a
 * shared style table (consistent with the rest of the UI).
 */
export interface BreakdownSegment {
  key: string
  label: string
  color: string
  value: number
}

/**
 * One bucket in the canonical response — the grid descriptor
 * fields plus the metric value(s). `value: null` means "no data
 * point for this bucket" (a real zero would be `value: 0`); we
 * keep the distinction so the chart can render "no data" gaps
 * differently from "the metric was zero".
 *
 * `breakdown` is optional — present only when the metric is
 * naturally stacked (today: visitors-by-source on the project
 * overview chart; tomorrow: anything we want to plot stacked).
 * When present, the `breakdown[]` values should sum to `value`.
 */
export interface ChartBucket extends BucketDescriptor {
  value: number | null
  breakdown?: BreakdownSegment[]
}

/**
 * The canonical wire shape. EVERY chart-data endpoint, post-
 * migration, returns this. Frontend consumes one shape regardless
 * of which provider/metric is behind it.
 *
 * `source` is attribution metadata — not read by the chart
 * itself, but lets tooltips, AI summaries, and CSV exports cite
 * the data source without per-component dispatch logic.
 */
export interface ChartSeries {
  granularity: ChartGranularity
  /** Bucket count == buckets.length. Carried explicitly so the
   *  client can detect a partially-populated response without
   *  having to count `null`s. */
  bucketCount: number
  buckets: ChartBucket[]
  source: {
    /** Provider name as used elsewhere in the codebase ('stripe',
     *  'posthog', 'google_analytics', 'composite' for connection-less
     *  views, etc.). */
    provider: string
    /** Connection that served this data, or null for composite
     *  views that resolve their own connection per-request. */
    connectionId: string | null
    /** Identifier for the metric within the provider — typically the
     *  view type (`stripe_gross`, `ga_users_today`) or an explicit
     *  metric name (`visitors`, `revenue`). */
    metric: string
  }
}

/**
 * The conventional mode → granularity mapping. Callers may override
 * (see Stripe Gross Volume's monthly view, which uses 'weekly'
 * instead of 'daily' so 31 daily bars don't crush into one
 * unreadable horizontal stripe on a small card).
 */
export function defaultGranularityForMode(
  mode: 'daily' | 'weekly' | 'monthly',
): ChartGranularity {
  switch (mode) {
    case 'daily':
      return 'hourly'
    case 'weekly':
      return 'daily'
    case 'monthly':
      // 'daily' (≈30 bars) is the default — matches GA/PostHog's
      // existing monthly behaviour. Callers wanting compact week-
      // bucket labels (Stripe) pass 'weekly' explicitly.
      return 'daily'
  }
}

// ────────────────────────────────────────────────────────────────────────
// Grid construction
// ────────────────────────────────────────────────────────────────────────

const MONTH_LABELS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const DAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtHourLabel(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

/**
 * Build the canonical grid for `(granularity, dateFrom, dateTo, tz)`.
 *
 * Determinism contract: same inputs → identical output. Two calls
 * from two different services for the same chart context produce
 * the same `bucketKey`s in the same order — that's what makes the
 * cross-series join valid.
 *
 * Bucket boundaries:
 *   - hourly: 24 buckets spanning a single calendar day in `tz`,
 *     starting at local midnight. `dateFrom` and `dateTo` must
 *     match (single-day-only); we throw otherwise.
 *   - daily: one bucket per calendar day from `dateFrom` to `dateTo`
 *     inclusive, each starting at local midnight in `tz`.
 *   - weekly: 7-day windows anchored at `dateFrom` (NOT ISO weeks).
 *     For "May 1–31" you get [May 1–7, May 8–14, May 15–21, May
 *     22–28, May 29–31]. The last bucket may be partial; we honour
 *     `dateTo` rather than extending past it.
 *   - monthly: one bucket per calendar month containing the range.
 *
 * Label formatting is context-aware:
 *   - hourly: hour-of-day ("12am", "1am", …, "11pm")
 *   - daily ≤ 7 buckets: weekday name ("Mon", "Tue", …)
 *   - daily > 7 buckets: month-day ("May 19")
 *   - weekly: range "May 1 – 7" (en-dash). Cross-month weeks spell
 *     out both months ("Apr 28 – May 4") so the boundary is
 *     unambiguous.
 *   - monthly: month + year ("May 2026")
 */
export function buildBucketGrid(
  granularity: ChartGranularity,
  dateFrom: string,
  dateTo: string,
  tzRaw: string,
): BucketDescriptor[] {
  const tz = safeTzLiteral(tzRaw)

  if (granularity === 'hourly') {
    if (dateFrom !== dateTo) {
      throw new Error(
        `buildBucketGrid: hourly granularity requires dateFrom === dateTo (got ${dateFrom}…${dateTo})`,
      )
    }
    const startUtc = localMidnightUtc(dateFrom, tz)
    const out: BucketDescriptor[] = []
    for (let h = 0; h < 24; h++) {
      const startMs = startUtc.getTime() + h * 3600_000
      // `h` here is the user-local hour-of-day BY CONSTRUCTION
      // (startUtc is at local midnight in tz, +h hours of UTC math
      // lands at local hour h modulo DST — DST jumps inside the
      // day are 2-3am in most zones, where this assertion holds).
      out.push({
        bucketKey: `${dateFrom}T${pad2(h)}:00`,
        bucketStartUnix: Math.floor(startMs / 1000),
        label: fmtHourLabel(h),
      })
    }
    return out
  }

  if (granularity === 'daily') {
    const startUtc = localMidnightUtc(dateFrom, tz)
    const endUtc = localMidnightUtc(dateTo, tz)
    const numDays =
      Math.round((endUtc.getTime() - startUtc.getTime()) / 86_400_000) + 1
    if (numDays < 1) {
      throw new Error(`buildBucketGrid: dateTo < dateFrom (${dateFrom}…${dateTo})`)
    }
    const useDayName = numDays <= 7
    const out: BucketDescriptor[] = []
    for (let i = 0; i < numDays; i++) {
      // `localMidnightUtc` for each successive day handles DST
      // transitions correctly (the offset can change mid-window).
      // Cheaper alternative would be `startUtc + i*86400_000` but
      // that drifts an hour across a DST boundary.
      const dayStr = dateStrInTzOffset(startUtc, tz, i)
      const dayUtc = localMidnightUtc(dayStr, tz)
      // Read the day-of-week in tz for the weekday label
      const fields = fieldsInTz(dayUtc, tz)
      // JS Date.UTC for the day-of-week index. Note: this is correct
      // because `fields` already yields year/month/day IN tz, and
      // Date.UTC interprets them as if UTC — the resulting weekday
      // is what `tz` would call the day.
      const dow = new Date(
        Date.UTC(fields.year, fields.month - 1, fields.day),
      ).getUTCDay()
      const label = useDayName
        ? DAY_LABELS_SHORT[dow]
        : `${MONTH_LABELS_SHORT[fields.month - 1]} ${fields.day}`
      out.push({
        bucketKey: dayStr,
        bucketStartUnix: Math.floor(dayUtc.getTime() / 1000),
        label,
      })
    }
    return out
  }

  if (granularity === 'weekly') {
    const startUtc = localMidnightUtc(dateFrom, tz)
    const endUtc = localMidnightUtc(dateTo, tz)
    const numDays =
      Math.round((endUtc.getTime() - startUtc.getTime()) / 86_400_000) + 1
    const numWeeks = Math.max(1, Math.ceil(numDays / 7))
    const out: BucketDescriptor[] = []
    for (let w = 0; w < numWeeks; w++) {
      const bucketStartStr = dateStrInTzOffset(startUtc, tz, w * 7)
      const bucketStartUtc = localMidnightUtc(bucketStartStr, tz)
      // End of this bucket = min(start + 6 days, dateTo). The
      // clamp is what makes "May 29 – 31" honest about being a
      // 3-day partial — labels never promise days that aren't there.
      const naiveEndDay = w * 7 + 6
      const lastDayInRange = numDays - 1
      const endDayOffset = Math.min(naiveEndDay, lastDayInRange)
      const bucketEndStr = dateStrInTzOffset(startUtc, tz, endDayOffset)
      const startFields = fieldsInTz(bucketStartUtc, tz)
      const endFields = fieldsInTz(localMidnightUtc(bucketEndStr, tz), tz)
      const sameMonth = startFields.month === endFields.month
      const startLabel = `${MONTH_LABELS_SHORT[startFields.month - 1]} ${startFields.day}`
      const endLabel = sameMonth
        ? String(endFields.day)
        : `${MONTH_LABELS_SHORT[endFields.month - 1]} ${endFields.day}`
      out.push({
        bucketKey: bucketStartStr,
        bucketStartUnix: Math.floor(bucketStartUtc.getTime() / 1000),
        // En-dash ` – ` rather than hyphen ` - `; reads cleaner in
        // numeric ranges at small font sizes (matches the typography
        // convention used elsewhere in the app).
        label: `${startLabel} – ${endLabel}`,
      })
    }
    return out
  }

  // monthly — one bucket per calendar month containing any part of
  // the range. Anchored to month-1 of `dateFrom`'s month.
  const startUtc = localMidnightUtc(dateFrom, tz)
  const endUtc = localMidnightUtc(dateTo, tz)
  const startFields = fieldsInTz(startUtc, tz)
  const endFields = fieldsInTz(endUtc, tz)
  const out: BucketDescriptor[] = []
  let y = startFields.year
  let m = startFields.month
  while (y < endFields.year || (y === endFields.year && m <= endFields.month)) {
    const monthStartStr = `${y}-${pad2(m)}-01`
    const monthStartUtc = localMidnightUtc(monthStartStr, tz)
    out.push({
      bucketKey: `${y}-${pad2(m)}`,
      bucketStartUnix: Math.floor(monthStartUtc.getTime() / 1000),
      label: `${MONTH_LABELS_SHORT[m - 1]} ${y}`,
    })
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/**
 * Helper: produce the YYYY-MM-DD string for `start + offsetDays` in `tz`,
 * surviving DST transitions. The naive `+offsetDays * 86_400_000` would
 * drift by an hour across a DST jump; this rebuilds the date by adding
 * days to the calendar fields then re-resolving local midnight, which
 * is DST-safe.
 */
function dateStrInTzOffset(startUtc: Date, tz: string, offsetDays: number): string {
  if (offsetDays === 0) return dateStrInTz(startUtc, tz)
  const fields = fieldsInTz(startUtc, tz)
  // `Date.UTC(y, m-1, d + offset)` rolls over correctly for negative
  // and large offsets (May 32 → June 1, March 0 → Feb 28/29).
  const shifted = new Date(
    Date.UTC(fields.year, fields.month - 1, fields.day + offsetDays),
  )
  // Read back in tz — handles the DST case where the "same date" in
  // local time crossed a transition.
  const shiftedFields = fieldsInTz(shifted, tz)
  return `${shiftedFields.year}-${pad2(shiftedFields.month)}-${pad2(shiftedFields.day)}`
}

// ────────────────────────────────────────────────────────────────────────
// Grid assignment
// ────────────────────────────────────────────────────────────────────────

/**
 * Lay raw provider data onto the canonical grid. Returns a
 * `ChartSeries.buckets[]` ready to be assembled into the wire
 * response.
 *
 * Three signatures by design:
 *
 *   1. **Pre-aggregated**: caller already grouped/summed its raw
 *      data by `bucketKey`. We just match to the grid + fill
 *      missing buckets with `null`. Used by PostHog HogQL (the
 *      query already aggregates) and GA (returns one row per
 *      bucket).
 *
 *   2. **Timestamped**: caller passes raw rows w/ Unix timestamps;
 *      we use the grid's `bucketStartUnix` boundaries to bin them.
 *      Used by Stripe charges (one row per charge, summed within
 *      a bucket).
 *
 * Both produce the same output shape. Missing buckets always get
 * `value: null` — a real zero stays as `value: 0`, so the chart
 * can render a "no data" gap differently from "the metric was zero
 * this hour".
 */
export function assignPreAggregated(
  rows: Array<{ bucketKey: string; value: number; breakdown?: BreakdownSegment[] }>,
  grid: BucketDescriptor[],
): ChartBucket[] {
  // Hash for O(1) per-row lookup. Same-key duplicates collapse
  // (last one wins). Callers needing sum-on-duplicate should
  // pre-merge before calling.
  const byKey = new Map<string, { value: number; breakdown?: BreakdownSegment[] }>()
  for (const r of rows) byKey.set(r.bucketKey, { value: r.value, breakdown: r.breakdown })
  return grid.map(g => {
    const found = byKey.get(g.bucketKey)
    return {
      ...g,
      value: found?.value ?? null,
      ...(found?.breakdown ? { breakdown: found.breakdown } : {}),
    }
  })
}

/**
 * Bin timestamped rows into the grid via binary search on
 * `bucketStartUnix`. Each row's value is added to its bucket via
 * `reducer` (default: sum). Rows outside the grid range are
 * silently dropped — defensive, but logs would be useful in
 * production if the caller wants to detect them. Buckets with no
 * matching rows get `value: null`.
 */
export function assignTimestamped<TRow>(
  rows: TRow[],
  grid: BucketDescriptor[],
  options: {
    /** Returns the row's instant as UTC seconds. */
    getTimestamp: (row: TRow) => number
    /** Returns the row's contribution to its bucket. */
    getValue: (row: TRow) => number
    /** How to combine multiple rows in the same bucket. Default: sum. */
    reducer?: (acc: number, value: number) => number
  },
): ChartBucket[] {
  if (grid.length === 0) return []
  const reducer = options.reducer ?? ((a, b) => a + b)

  // Track which buckets have received at least one row, so we can
  // emit `value: null` for the rest (rather than `value: 0` which
  // would render as a zero-bar instead of a gap).
  const sums = new Array<number | null>(grid.length).fill(null)
  const firstBucketStart = grid[0].bucketStartUnix
  // For binary search: the EXCLUSIVE upper bound of the whole grid.
  // We don't know it from the grid alone — last bucket has no
  // explicit end. Estimate from the spacing between buckets.
  const lastBucketStart = grid[grid.length - 1].bucketStartUnix
  const avgBucketSec =
    grid.length > 1
      ? (lastBucketStart - firstBucketStart) / (grid.length - 1)
      : 24 * 3600 // single-bucket grid — assume daily span as a guess
  const gridEndExclusive = lastBucketStart + avgBucketSec

  for (const row of rows) {
    const ts = options.getTimestamp(row)
    if (ts < firstBucketStart || ts >= gridEndExclusive) continue
    // Binary search for the largest bucketStart <= ts.
    let lo = 0
    let hi = grid.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (grid[mid].bucketStartUnix <= ts) lo = mid
      else hi = mid - 1
    }
    const v = options.getValue(row)
    sums[lo] = reducer(sums[lo] ?? 0, v)
  }

  return grid.map((g, i) => ({ ...g, value: sums[i] }))
}

// ────────────────────────────────────────────────────────────────────────
// Self-checks (inline; run manually via `node -e` or a smoke script)
// ────────────────────────────────────────────────────────────────────────

/**
 * Hand-runnable smoke tests. Not exported in the type system —
 * callable via `chartGridSelfCheck()` for ad-hoc validation. Kept
 * in this file (not a separate test) because the codebase doesn't
 * have Jest wired up; these are belt-and-suspenders confidence
 * checks for the grid math.
 *
 * Run manually:
 *   node --loader ts-node/esm -e "import('./src/common/chart-grid').then(m => m.chartGridSelfCheck())"
 */
export function chartGridSelfCheck(): void {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`chart-grid self-check FAIL: ${msg}`)
  }

  // hourly: 24 buckets, single day, UTC
  {
    const g = buildBucketGrid('hourly', '2026-05-19', '2026-05-19', 'UTC')
    assert(g.length === 24, `hourly UTC expected 24 buckets, got ${g.length}`)
    assert(g[0].label === '12am', `hourly[0] label should be 12am, got ${g[0].label}`)
    assert(g[23].label === '11pm', `hourly[23] label should be 11pm, got ${g[23].label}`)
    assert(g[0].bucketKey === '2026-05-19T00:00', `hourly[0] key: ${g[0].bucketKey}`)
    assert(g[14].bucketKey === '2026-05-19T14:00', `hourly[14] key: ${g[14].bucketKey}`)
  }

  // daily, 7 days → weekday labels
  {
    const g = buildBucketGrid('daily', '2026-05-11', '2026-05-17', 'UTC')
    assert(g.length === 7, `weekly daily expected 7 buckets, got ${g.length}`)
    // May 11, 2026 is a Monday
    assert(g[0].label === 'Mon', `weekly[0] label should be Mon, got ${g[0].label}`)
    assert(g[6].label === 'Sun', `weekly[6] label should be Sun, got ${g[6].label}`)
    assert(g[0].bucketKey === '2026-05-11', `weekly[0] key: ${g[0].bucketKey}`)
  }

  // daily, >7 days → month-day labels
  {
    const g = buildBucketGrid('daily', '2026-05-01', '2026-05-31', 'UTC')
    assert(g.length === 31, `monthly daily expected 31 buckets, got ${g.length}`)
    assert(g[0].label === 'May 1', `monthly[0] label: ${g[0].label}`)
    assert(g[30].label === 'May 31', `monthly[30] label: ${g[30].label}`)
  }

  // weekly, May 1-31 → 5 buckets, last is partial
  {
    const g = buildBucketGrid('weekly', '2026-05-01', '2026-05-31', 'UTC')
    assert(g.length === 5, `weekly May expected 5 buckets, got ${g.length}`)
    assert(g[0].label === 'May 1 – 7', `weekly[0] label: ${g[0].label}`)
    assert(g[4].label === 'May 29 – 31', `weekly[4] (partial) label: ${g[4].label}`)
  }

  // weekly cross-month, Apr 28 - May 4 → label spells out months
  {
    const g = buildBucketGrid('weekly', '2026-04-28', '2026-05-04', 'UTC')
    assert(g.length === 1, `cross-month weekly expected 1 bucket, got ${g.length}`)
    assert(g[0].label === 'Apr 28 – May 4', `cross-month weekly label: ${g[0].label}`)
  }

  // monthly: bucket count = months spanned
  {
    const g = buildBucketGrid('monthly', '2026-03-15', '2026-07-15', 'UTC')
    assert(g.length === 5, `monthly Mar→Jul expected 5 buckets, got ${g.length}`)
    assert(g[0].label === 'Mar 2026', `monthly[0] label: ${g[0].label}`)
    assert(g[4].label === 'Jul 2026', `monthly[4] label: ${g[4].label}`)
    assert(g[0].bucketKey === '2026-03', `monthly[0] key: ${g[0].bucketKey}`)
  }

  // assignPreAggregated: missing buckets → null, present → value
  {
    const grid = buildBucketGrid('daily', '2026-05-01', '2026-05-03', 'UTC')
    const out = assignPreAggregated(
      [
        { bucketKey: '2026-05-01', value: 5 },
        { bucketKey: '2026-05-03', value: 12 },
      ],
      grid,
    )
    assert(out[0].value === 5, `assignPreAgg[0]: ${out[0].value}`)
    assert(out[1].value === null, `assignPreAgg[1] (missing): ${out[1].value}`)
    assert(out[2].value === 12, `assignPreAgg[2]: ${out[2].value}`)
  }

  // assignTimestamped: bin charges by bucket, sum duplicates
  {
    const grid = buildBucketGrid('daily', '2026-05-01', '2026-05-03', 'UTC')
    const may1Noon = new Date('2026-05-01T12:00:00Z').getTime() / 1000
    const may3Morn = new Date('2026-05-03T08:30:00Z').getTime() / 1000
    const out = assignTimestamped(
      [
        { ts: may1Noon, amount: 100 },
        { ts: may1Noon + 60, amount: 50 }, // same day, should sum to 150
        { ts: may3Morn, amount: 200 },
      ],
      grid,
      { getTimestamp: r => r.ts, getValue: r => r.amount },
    )
    assert(out[0].value === 150, `assignTs[0] sum: ${out[0].value}`)
    assert(out[1].value === null, `assignTs[1] (no charges): ${out[1].value}`)
    assert(out[2].value === 200, `assignTs[2]: ${out[2].value}`)
  }

  // assignTimestamped: out-of-range rows are silently dropped
  {
    const grid = buildBucketGrid('daily', '2026-05-01', '2026-05-01', 'UTC')
    const may2 = new Date('2026-05-02T12:00:00Z').getTime() / 1000
    const out = assignTimestamped(
      [{ ts: may2, amount: 999 }],
      grid,
      { getTimestamp: r => r.ts, getValue: r => r.amount },
    )
    assert(out[0].value === null, `out-of-range drop: ${out[0].value}`)
  }

  // eslint-disable-next-line no-console
  console.log('✓ chart-grid self-check passed')
}
