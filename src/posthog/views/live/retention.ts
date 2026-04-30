import { Logger } from '@nestjs/common'
import type { PosthogCredentials } from '../../connection/credentials'

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
 *   - Cohort buckets pin to UTC `toDate()`. No per-user timezone. Acceptable
 *     because 90%+ of solo founders running this on small data won't notice
 *     a date shift; revisit when retention is actually used in production.
 *   - We don't filter the cohort window by `dateFrom` — instead we backfill
 *     `cohortCount` periods up to and including `dateTo`. That keeps the
 *     UX simple ("show me last 7 days of cohorts") regardless of how the
 *     global picker is set; the global range still bounds the *return*
 *     window so cells that haven't happened yet stay null.
 *   - Period boundaries: `day` → `toDate(timestamp)`. `week` → `toMonday(toDate(timestamp))`.
 *     Same convention PostHog's own retention uses.
 */
export function buildRetentionHogql(
  config: RetentionConfig,
  dateTo: string,
): { cohortQuery: string; returnsQuery: string } {
  const safeStart = config.startEvent.replace(/'/g, "\\'")
  const safeReturn = config.returnEvent.replace(/'/g, "\\'")
  const safeTo = dateTo.replace(/'/g, '')
  const period = config.period
  const cohortCount = Math.max(1, Math.min(60, Math.floor(config.cohortCount)))
  const retentionPeriods = Math.max(1, Math.min(60, Math.floor(config.retentionPeriods)))

  // Period bucket function — same expression used in both CTEs.
  const bucketExpr =
    period === 'week'
      ? `toMonday(toDate(timestamp))`
      : `toDate(timestamp)`

  // Window math: how far back the cohort window opens. Driven by the bucket
  // unit so a 7-day cohortCount looks back 7 days; a 7-week one looks back
  // 49 days. ClickHouse INTERVAL syntax handles both natively.
  const intervalUnit = period === 'week' ? 'WEEK' : 'DAY'
  const cohortLookback = cohortCount + retentionPeriods // generous: we want every cohort row to potentially have all columns of return data even if the dates are in the past

  // CTE 1 — cohort: each user's *first* startEvent bucket.
  // We restrict to events at or before `dateTo` (no future events) and
  // within the lookback so we don't scan all-time data.
  const cohortQuery = `SELECT person_id, min(${bucketExpr}) AS cohort_start FROM events WHERE event = '${safeStart}' AND toDate(timestamp) >= toDate('${safeTo}') - INTERVAL ${cohortLookback} ${intervalUnit} AND toDate(timestamp) <= toDate('${safeTo}') GROUP BY person_id`

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
  const returnsQuery = `SELECT c.cohort_start AS cohort_start, dateDiff('${diffUnit}', c.cohort_start, ${bucketExpr}) AS period_offset, count(DISTINCT e.person_id) AS retained FROM events AS e INNER JOIN (${cohortQuery}) AS c ON e.person_id = c.person_id WHERE e.event = '${safeReturn}' AND toDate(e.timestamp) >= c.cohort_start AND toDate(e.timestamp) <= toDate('${safeTo}') AND dateDiff('${diffUnit}', c.cohort_start, ${bucketExpr.replace(/timestamp/g, 'e.timestamp')}) >= 0 AND dateDiff('${diffUnit}', c.cohort_start, ${bucketExpr.replace(/timestamp/g, 'e.timestamp')}) < ${retentionPeriods} GROUP BY cohort_start, period_offset ORDER BY cohort_start, period_offset`

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
  ph: PosthogCredentials,
  config: RetentionConfig,
  dateTo: string,
  logger: Logger,
): Promise<{ cohorts: RetentionRow[]; periodLabel: RetentionPeriod }> {
  const { cohortQuery, returnsQuery } = buildRetentionHogql(config, dateTo)

  // Cohort sizes. We wrap the inline cohort CTE in an outer aggregate.
  const sizesHogql = `SELECT cohort_start, count(DISTINCT person_id) FROM (${cohortQuery}) GROUP BY cohort_start ORDER BY cohort_start`
  logger.log(`  → posthog retention sizes HogQL: ${sizesHogql}`)

  const sizesRes = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sizesHogql } }),
  })

  if (!sizesRes.ok) {
    const body = await sizesRes.text()
    logger.error(`PostHog retention cohort-sizes failed: ${body}`)
    return { cohorts: [], periodLabel: config.period }
  }

  const sizesJson = (await sizesRes.json()) as { results?: [string, number | string][] }
  const cohortSizes: CohortSizeRow[] = (sizesJson.results ?? []).map(([d, n]) => ({
    cohortStart: String(d ?? ''),
    size: Number(n) || 0,
  }))

  if (cohortSizes.length === 0) {
    return { cohorts: [], periodLabel: config.period }
  }

  // Returns matrix.
  logger.log(`  → posthog retention returns HogQL: ${returnsQuery}`)
  const returnsRes = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: returnsQuery } }),
  })

  if (!returnsRes.ok) {
    const body = await returnsRes.text()
    logger.error(`PostHog retention returns failed: ${body}`)
    return { cohorts: [], periodLabel: config.period }
  }

  const returnsJson = (await returnsRes.json()) as {
    results?: [string, number | string, number | string][]
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
