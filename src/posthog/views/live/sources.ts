import { Logger } from '@nestjs/common'
import {
  escapeDateLiteral,
  escapeStringLiteral,
  POSTHOG_SOURCE_EXPR,
  tzDateBucket,
  tzWrappedTimestamp,
} from './hogql-utils'
import type { PosthogCredentials } from '../../connection/credentials'

export type BucketGranularity = 'hourly' | 'daily'

export interface SourceBucketRow {
  bucketKey: string
  source: string
  value: number
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
 * bucketKey format: "YYYY-MM-DD HH:00:00" for hourly, "YYYY-MM-DD" for daily,
 * both rendered in `tz`. We can't pass `tz` as a second arg to
 * `toStartOfHour`/`toDate` (HogQL is 1-arg only) — instead we wrap with
 * `toTimeZone(timestamp, tz)` and truncate. Default `tz='UTC'` preserves the
 * legacy shape (toTimeZone(ts, 'UTC') is a no-op for a UTC-stored column).
 */
export async function fetchPosthogSourcesByBucket(
  ph: PosthogCredentials,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
  tz: string = 'UTC',
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
  const hogql = `SELECT ${timeExpr} AS bucket, ${POSTHOG_SOURCE_EXPR} AS src, count() FROM events WHERE event = '$pageview' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY bucket, src ORDER BY bucket`

  const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error(`PostHog sources query failed: ${body}`)
    return []
  }

  const json = (await res.json()) as { results?: [unknown, string | null, number][] }
  const rows: SourceBucketRow[] = []
  for (const [bucket, src, count] of json.results ?? []) {
    rows.push({
      bucketKey: String(bucket),
      source: src ?? '',
      value: Number(count) || 0,
    })
  }
  return rows
}

/**
 * Count of a given event per bucket (no source split). Used for conversions.
 * `tz` controls the timezone in which buckets are emitted (default UTC).
 */
export async function fetchPosthogEventCountByBucket(
  ph: PosthogCredentials,
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

  const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error(`PostHog event-count query failed: ${body}`)
    return []
  }

  const json = (await res.json()) as { results?: [unknown, number][] }
  return (json.results ?? []).map(([bucket, count]) => ({
    bucketKey: String(bucket),
    value: Number(count) || 0,
  }))
}

/**
 * Returns up to 200 distinct event names seen recently — used by the Settings conversion-event dropdown.
 */
export async function listPosthogEventNames(
  ph: PosthogCredentials,
  logger: Logger,
): Promise<string[]> {
  const url = `${ph.host}/api/projects/${ph.projectId}/event_definitions/?limit=200`
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ph.apiKey}` } })
    if (!res.ok) {
      logger.warn(`PostHog event_definitions responded ${res.status}`)
      return []
    }
    const json = (await res.json()) as { results: { name: string }[] }
    return json.results.map(r => r.name)
  } catch (err) {
    logger.warn(`PostHog event definitions fetch error: ${String(err)}`)
    return []
  }
}
