import { Logger } from '@nestjs/common'
import {
  escapeDateLiteral,
  escapeStringLiteral,
  tzDateBucket,
} from './hogql-utils'
import { PosthogApiClient } from '../../posthog-api.client'

export type RetentionPeriod = 'day' | 'week'

export interface RetentionConfig {
  /** Event that defines the cohort. A user joins the cohort dated their
   *  *first* occurrence of this event in the cohort window. Defaults to
   *  `$pageview` in the picker. */
  startEvent: string
  /** Event that counts as a "return". Often the same as `startEvent`. */
  returnEvent: string
  period: RetentionPeriod
  /** Number of cohort rows. Each row is one period (day or week) starting
   *  back from `dateTo`. */
  cohortCount: number
  /** Number of retention columns including period 0 (the cohort itself). */
  retentionPeriods: number
}

export interface RetentionRow {
  /** ISO date (UTC) for the cohort's start day/week. */
  startDate: string
  /** Cohort size = users whose *first* `startEvent` fell in this period. */
  size: number
  /** `returns[i]` = retained users in period offset i (period 0 always
   *  equals `size`). `null` means the period hasn't been observed yet
   *  (the future) — render as `—` not 0%. */
  returns: (number | null)[]
}

/**
 * Pure HogQL builder for the retention matrix.
 *
 * Strategy: one CTE pinning each user's *first* `startEvent` to a cohort
 * bucket (day or week, UTC), a second CTE counting distinct users per
 * cohort × period-offset against the `returnEvent` stream, then aggregating.
 *
 * v1 simplifications (documented in plan, repeated here so the SQL author
 * can find them):
 *   - We don't filter the cohort window by `dateFrom` — instead we backfill
 *     `cohortCount` periods up to and including `dateTo`. That keeps the
 *     UX simple ("show me last 7 days of cohorts") regardless of how the
 *     global picker is set; the global range still bounds the *return*
 *     window so cells that haven't happened yet stay null.
 *   - Period boundaries: `day` → `toDate(toTimeZone(timestamp, tz))`.
 *     `week` → `toMonday(toDate(toTimeZone(timestamp, tz)))`. Same
 *     convention PostHog's own retention uses, but tz-aware so a
 *     "Monday" means the user's wall-clock Monday in their zone.
 *
 * HogQL quirks worth noting (same as funnel.ts/sources.ts):
 *   - `toDate` is single-arg only; `toDate(ts, tz)` fails the parser.
 *   - The function is `toTimeZone` (capital Z); `toTimezone` is rejected.
 */
export function buildRetentionHogql(
  config: RetentionConfig,
  dateTo: string,
  tz: string = 'UTC',
): { cohortQuery: string; returnsQuery: string } {
  const safeStart = escapeStringLiteral(config.startEvent)
  const safeReturn = escapeStringLiteral(config.returnEvent)
  const safeTo = escapeDateLiteral(dateTo)
  const period = config.period
  const cohortCount = Math.max(1, Math.min(60, Math.floor(config.cohortCount)))
  const retentionPeriods = Math.max(1, Math.min(60, Math.floor(config.retentionPeriods)))

  // Two flavours of `toDate(toTimeZone(...))` — the bare `timestamp`
  // reference in the cohort CTE, and `e.timestamp` in the returns CTE
  // that joins events twice. Computed once each; reused at every
  // interpolation point.
  const tzDate = tzDateBucket(tz)
  const tzDateE = tzDateBucket(tz, 'e.timestamp')

  // Period bucket function — same expression used in both CTEs. `week`
  // pins to Mondays via `toMonday(...)`, mirroring PostHog's own
  // retention math.
  const bucketExpr = period === 'week' ? `toMonday(${tzDate})` : tzDate
  const bucketExprE = period === 'week' ? `toMonday(${tzDateE})` : tzDateE

  // Window math: how far back the cohort window opens. Driven by the bucket
  // unit so a 7-day cohortCount looks back 7 days; a 7-week one looks back
  // 49 days. ClickHouse INTERVAL syntax handles both natively.
  const intervalUnit = period === 'week' ? 'WEEK' : 'DAY'
  const cohortLookback = cohortCount + retentionPeriods // generous: we want every cohort row to potentially have all columns of return data even if the dates are in the past

  // CTE 1 — cohort: each user's *first* startEvent bucket.
  // We restrict to events at or before `dateTo` (no future events) and
  // within the lookback so we don't scan all-time data.
  const cohortQuery = `SELECT person_id, min(${bucketExpr}) AS cohort_start FROM events WHERE event = '${safeStart}' AND ${tzDate} >= toDate('${safeTo}') - INTERVAL ${cohortLookback} ${intervalUnit} AND ${tzDate} <= toDate('${safeTo}') GROUP BY person_id`

  // CTE 2 — returns: distinct users per (cohort, period-offset).
  // We join the cohort table to the returns event stream, compute the
  // offset in periods, and count distinct users. dateDiff('day'|'week', a, b)
  // gives us a non-negative integer offset; offsets ≥ retentionPeriods are
  // outside the matrix and dropped.
  //
  // SUBQUERY for the cohort CTE is inlined twice rather than using `WITH`,
  // because HogQL's `WITH` support is patchy; inlined subqueries are the
  // safest cross-version pattern. Same trick `sources.ts` uses elsewhere.
  const diffUnit = period === 'week' ? 'week' : 'day'
  const returnsQuery = `SELECT c.cohort_start AS cohort_start, dateDiff('${diffUnit}', c.cohort_start, ${bucketExprE}) AS period_offset, count(DISTINCT e.person_id) AS retained FROM events AS e INNER JOIN (${cohortQuery}) AS c ON e.person_id = c.person_id WHERE e.event = '${safeReturn}' AND ${tzDateE} >= c.cohort_start AND ${tzDateE} <= toDate('${safeTo}') AND dateDiff('${diffUnit}', c.cohort_start, ${bucketExprE}) >= 0 AND dateDiff('${diffUnit}', c.cohort_start, ${bucketExprE}) < ${retentionPeriods} GROUP BY cohort_start, period_offset ORDER BY cohort_start, period_offset`

  return { cohortQuery, returnsQuery }
}

interface CohortSizeRow {
  cohortStart: string
  size: number
}

/**
 * Run the cohort + returns queries and assemble the matrix.
 *
 * Two HogQL round-trips: one to size each cohort (count distinct
 * `person_id` from `cohortQuery`), one for the per-cell returns. We could
 * collapse to one with a CTE-style query but HogQL's CTE support has been
 * uneven — splitting keeps things robust at the cost of one extra request,
 * which on solo-founder-scale data is invisible.
 */
export async function fetchPosthogRetention(
  client: PosthogApiClient,
  config: RetentionConfig,
  dateTo: string,
  logger: Logger,
  tz: string = 'UTC',
): Promise<{ cohorts: RetentionRow[]; periodLabel: RetentionPeriod }> {
  const { cohortQuery, returnsQuery } = buildRetentionHogql(config, dateTo, tz)

  // Cohort sizes. We wrap the inline cohort CTE in an outer aggregate.
  const sizesHogql = `SELECT cohort_start, count(DISTINCT person_id) FROM (${cohortQuery}) GROUP BY cohort_start ORDER BY cohort_start`
  logger.log(`  → posthog retention sizes HogQL: ${sizesHogql}`)

  let sizesJson: { results?: [string, number | string][] }
  try {
    sizesJson = (await client.queryHogql(sizesHogql)) as { results?: [string, number | string][] }
  } catch (err) {
    logger.error(`PostHog retention cohort-sizes failed: ${String(err)}`)
    return { cohorts: [], periodLabel: config.period }
  }

  const cohortSizes: CohortSizeRow[] = (sizesJson.results ?? []).map(([d, n]) => ({
    cohortStart: String(d ?? ''),
    size: Number(n) || 0,
  }))

  if (cohortSizes.length === 0) {
    return { cohorts: [], periodLabel: config.period }
  }

  // Returns matrix.
  logger.log(`  → posthog retention returns HogQL: ${returnsQuery}`)
  let returnsJson: { results?: [string, number | string, number | string][] }
  try {
    returnsJson = (await client.queryHogql(returnsQuery)) as {
      results?: [string, number | string, number | string][]
    }
  } catch (err) {
    logger.error(`PostHog retention returns failed: ${String(err)}`)
    return { cohorts: [], periodLabel: config.period }
  }

  // Stitch: lookup cohort_start → row index, fill `returns[period_offset]`.
  const periods = Math.max(1, Math.floor(config.retentionPeriods))
  const today = dateTo
  const rows: RetentionRow[] = cohortSizes.map(c => ({
    startDate: c.cohortStart,
    size: c.size,
    // Initialize all cells. We'll mark cells that are in the *future*
    // (i.e. their target period hasn't elapsed yet by `today`) as null
    // after we know the period unit.
    returns: new Array(periods).fill(0),
  }))
  const indexByStart = new Map(rows.map((r, i) => [r.startDate, i]))

  for (const [cohortStart, offset, retained] of returnsJson.results ?? []) {
    const i = indexByStart.get(String(cohortStart))
    if (i == null) continue
    const off = Number(offset)
    if (off < 0 || off >= periods) continue
    rows[i].returns[off] = Number(retained) || 0
  }

  // Mask future cells: a cell at offset `k` requires the cohort to have
  // existed for at least `k` periods. If `cohortStart + k periods > today`,
  // we don't have data yet → render `—`. Doing this here (vs. in HogQL)
  // keeps the SQL single-purpose.
  const periodMs = config.period === 'week' ? 7 * 86400_000 : 86400_000
  const todayMs = Date.parse(today)
  for (const row of rows) {
    const startMs = Date.parse(row.startDate)
    if (Number.isNaN(startMs)) continue
    for (let k = 0; k < periods; k++) {
      const cellEndMs = startMs + (k + 1) * periodMs
      if (cellEndMs > todayMs + periodMs) {
        // Not enough time has elapsed for this cell to be observable.
        row.returns[k] = null
      }
    }
  }

  return { cohorts: rows, periodLabel: config.period }
}
