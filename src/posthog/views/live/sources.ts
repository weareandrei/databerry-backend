import { Logger } from '@nestjs/common'
import {
  escapeDateLiteral,
  escapeStringLiteral,
  POSTHOG_SOURCE_EXPR,
  tzDateBucket,
  tzWrappedTimestamp,
} from './hogql-utils'
import { PosthogApiClient } from '../../posthog-api.client'

import type { BucketGranularity } from '../../../common/types'
export type { BucketGranularity }

/**
 * Which number a traffic query counts. THE distinction this codebase
 * conflated for months:
 *   - 'visitors'  → unique PEOPLE (`count(DISTINCT person_id)` —
 *     person_id is the merged identity, so pre/post-identify events
 *     from the same human count once)
 *   - 'pageviews' → raw `$pageview` EVENT count (one person opening
 *     five pages = 5)
 * Callers MUST pick explicitly; the default preserves the legacy
 * behaviour (event counts).
 */
export type TrafficMetric = 'visitors' | 'pageviews'

const AGG_EXPR: Record<TrafficMetric, string> = {
  visitors: 'count(DISTINCT person_id)',
  pageviews: 'count()',
}

export interface SourceBucketRow {
  bucketKey: string
  source: string
  value: number
}

/**
 * Canonicalize a HogQL bucket value to the EXACT shapes the
 * project-overview matcher expects:
 *   - daily  → "YYYY-MM-DD" (passes through untouched)
 *   - hourly → "YYYY-MM-DDTHH:00:00" (matches `phHourlyKeyInTz`)
 *
 * Needed because PostHog's serialization of DateTime results is not
 * stable across response shapes: hourly buckets have been observed
 * as "YYYY-MM-DD HH:00:00" (space separator) and as ISO-8601 WITH a
 * timezone suffix ("…T14:00:00+02:00"). Either variant misses the
 * matcher's key index, which zeroed every bar of the daily (hourly)
 * chart while non-bucketed totals still showed — the classic
 * "I see a total but no chart" bug. Unifying the separator and
 * slicing to seconds makes all variants converge on the matcher
 * key.
 */
function normalizeBucketKey(raw: unknown): string {
  const s = String(raw)
  if (s.length <= 10) return s // date-only — already canonical
  return s.replace(' ', 'T').slice(0, 19)
}

/**
 * Hour-bucket expression in `tz`. HogQL's `toStartOfHour` is single-arg
 * only — and `toDate` and `toTimeZone` have their own quirks documented
 * in `hogql-utils.ts`. We convert `timestamp` to the target zone first,
 * then truncate. The returned DateTime serializes to the same wall-clock
 * string the caller expects — `phHourlyKeyInTz` produces matching keys.
 */
function hourBucketExpr(tz: string): string {
  return `toStartOfHour(${tzWrappedTimestamp(tz)})`
}

/**
 * Posthog sources-by-bucket (via HogQL).
 * bucketKey format (post-normalization): "YYYY-MM-DDTHH:00:00" for
 * hourly (matching `phHourlyKeyInTz`), "YYYY-MM-DD" for daily, both
 * rendered in `tz`. We can't pass `tz` as a second arg to
 * `toStartOfHour`/`toDate` (HogQL is 1-arg only) — instead we wrap with
 * `toTimeZone(timestamp, tz)` and truncate. Default `tz='UTC'` preserves the
 * legacy shape (toTimeZone(ts, 'UTC') is a no-op for a UTC-stored column).
 */
export async function fetchPosthogSourcesByBucket(
  client: PosthogApiClient,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
  tz: string = 'UTC',
  metric: TrafficMetric = 'pageviews',
): Promise<SourceBucketRow[]> {
  const tzDate = tzDateBucket(tz)
  const timeExpr = granularity === 'hourly' ? hourBucketExpr(tz) : tzDate

  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)

  // `src` uses the shared first-touch attribution expression
  // (`POSTHOG_SOURCE_EXPR`: ref → utm_source → referring_domain) so this
  // panel/chart and the per-user list stay in lockstep. See its docstring
  // in hogql-utils.ts for the precedence + the retroactive-recovery note.
  //
  // Parens around the BETWEEN are load-bearing: HogQL's parser binds the
  // surrounding AND tighter than BETWEEN, so without them the query reads
  // as `(event = '$pageview' AND toDate(timestamp)) BETWEEN x AND y`, which
  // tries to AND a string with a Date and bombs out with
  // "Illegal type (Date) of 2 argument of function and".
  //
  // The BETWEEN bound also runs in `tz` (via the toTimeZone wrap inside
  // `tzDateBucket`) so a "today" range maps to the user's local day, not UTC.
  const hogql = `SELECT ${timeExpr} AS bucket, ${POSTHOG_SOURCE_EXPR} AS src, ${AGG_EXPR[metric]} FROM events WHERE event = '$pageview' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY bucket, src ORDER BY bucket`

  try {
    const json = (await client.queryHogql(hogql)) as {
      results?: [unknown, string | null, number][]
    }
    const rows: SourceBucketRow[] = []
    for (const [bucket, src, count] of json.results ?? []) {
      rows.push({
        bucketKey: normalizeBucketKey(bucket),
        source: src ?? '',
        value: Number(count) || 0,
      })
    }
    return rows
  } catch (err) {
    logger.error(`PostHog sources query failed: ${String(err)}`)
    return []
  }
}

/**
 * Range-wide UNIQUE visitor count — a single `count(DISTINCT person_id)`
 * over the whole [from, to] window, with NO time bucketing.
 *
 * Why this exists separately from the bucketed query: unique counts
 * DON'T SUM. Summing the per-hour distinct-person counts (what the
 * chart's bars hold in daily mode) double-counts anyone who visited in
 * more than one hour — so a returning visitor inflates the headline
 * total above the true number of people (and can even push it above
 * the pageview count, which looks impossible). This query dedupes once
 * across the entire range, so it matches PostHog's own "unique
 * visitors" and reconciles with the (also-deduped) sources panel.
 *
 * Same `$pageview` scope, same tz-aware BETWEEN bound, same first-touch
 * window as `fetchPosthogSourcesByBucket` so the two stay comparable.
 */
export async function fetchPosthogVisitorsTotal(
  client: PosthogApiClient,
  dateFrom: string,
  dateTo: string,
  logger: Logger,
  tz: string = 'UTC',
): Promise<number> {
  const tzDate = tzDateBucket(tz)
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)
  const hogql = `SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}'))`

  try {
    const json = (await client.queryHogql(hogql)) as { results?: [number][] }
    return Number(json.results?.[0]?.[0]) || 0
  } catch (err) {
    logger.error(`PostHog visitors-total query failed: ${String(err)}`)
    return 0
  }
}

/**
 * Count of a given event per bucket (no source split). Used for conversions.
 * `tz` controls the timezone in which buckets are emitted (default UTC).
 */
export async function fetchPosthogEventCountByBucket(
  client: PosthogApiClient,
  eventName: string,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
  tz: string = 'UTC',
): Promise<{ bucketKey: string; value: number }[]> {
  const tzDate = tzDateBucket(tz)
  const timeExpr = granularity === 'hourly' ? hourBucketExpr(tz) : tzDate

  const safeEvent = escapeStringLiteral(eventName)
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)

  // See note in fetchPosthogSourcesByBucket: parens around BETWEEN are
  // load-bearing because HogQL's AND binds tighter than BETWEEN.
  const hogql = `SELECT ${timeExpr} AS bucket, count() FROM events WHERE event = '${safeEvent}' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY bucket ORDER BY bucket`

  try {
    const json = (await client.queryHogql(hogql)) as { results?: [unknown, number][] }
    return (json.results ?? []).map(([bucket, count]) => ({
      bucketKey: normalizeBucketKey(bucket),
      value: Number(count) || 0,
    }))
  } catch (err) {
    logger.error(`PostHog event-count query failed: ${String(err)}`)
    return []
  }
}

/**
 * Returns up to 200 distinct event names seen recently — used by the Settings conversion-event dropdown.
 */
export async function listPosthogEventNames(
  client: PosthogApiClient,
  logger: Logger,
): Promise<string[]> {
  try {
    const json = await client.getEventDefinitions()
    return (json.results ?? []).map(r => r.name)
  } catch (err) {
    logger.warn(`PostHog event definitions fetch error: ${String(err)}`)
    return []
  }
}
