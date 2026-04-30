import { Logger } from '@nestjs/common'
import type { PosthogCredentials } from '../../connection/credentials'

export type BucketGranularity = 'hourly' | 'daily'

export interface SourceBucketRow {
  bucketKey: string
  source: string
  value: number
}

/**
 * Sanitize an IANA timezone string for safe injection into a HogQL string
 * literal. IANA names use only `[A-Za-z0-9_/+-]`; anything else (quotes,
 * spaces, control chars) is treated as injection and falls back to UTC.
 */
function safeTzLiteral(tz: string | undefined): string {
  return typeof tz === 'string' && /^[A-Za-z0-9_/+-]+$/.test(tz) ? tz : 'UTC'
}

/**
 * Hour-bucket expression in `tzLit`. We can't use `toStartOfHour(ts, tz)` —
 * unlike ClickHouse's `toDate`, `toStartOfHour` is single-arg in HogQL and
 * the 2-arg call fails validation ("Function 'toStartOfHour' expects 1
 * argument, found 2"). Convert the timestamp to the target zone first, then
 * truncate. The returned DateTime serializes to the same wall-clock string
 * the caller expects — `phHourlyKeyInTz` produces matching bucket keys.
 */
function hourBucketExpr(tzLit: string): string {
  return `toStartOfHour(toTimezone(timestamp, '${tzLit}'))`
}

/**
 * Posthog sources-by-bucket (via HogQL).
 * bucketKey format: "YYYY-MM-DD HH:00:00" for hourly, "YYYY-MM-DD" for daily,
 * both rendered in `tz` (passed through to ClickHouse `toStartOfHour`/`toDate`
 * as the second argument). Default `tz='UTC'` preserves the legacy shape.
 */
export async function fetchPosthogSourcesByBucket(
  ph: PosthogCredentials,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
  tz: string = 'UTC',
): Promise<SourceBucketRow[]> {
  const tzLit = safeTzLiteral(tz)
  const timeExpr =
    granularity === 'hourly'
      ? hourBucketExpr(tzLit)
      : `toDate(timestamp, '${tzLit}')`

  const safeFrom = dateFrom.replace(/'/g, '')
  const safeTo = dateTo.replace(/'/g, '')

  // `$initial_referring_domain` is the standard Posthog property for session source.
  //
  // Parens around the BETWEEN are load-bearing: HogQL's parser binds the
  // surrounding AND tighter than BETWEEN, so without them the query reads
  // as `(event = '$pageview' AND toDate(timestamp)) BETWEEN x AND y`, which
  // tries to AND a string with a Date and bombs out with
  // "Illegal type (Date) of 2 argument of function and".
  //
  // The BETWEEN bound also runs in `tz` so a "today" range maps to the
  // user's local day, not UTC.
  const hogql = `SELECT ${timeExpr} AS bucket, properties.$initial_referring_domain AS src, count() FROM events WHERE event = '$pageview' AND (toDate(timestamp, '${tzLit}') BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY bucket, src ORDER BY bucket`

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
  const tzLit = safeTzLiteral(tz)
  const timeExpr =
    granularity === 'hourly'
      ? hourBucketExpr(tzLit)
      : `toDate(timestamp, '${tzLit}')`

  const safeEvent = eventName.replace(/'/g, "\\'")
  const safeFrom = dateFrom.replace(/'/g, '')
  const safeTo = dateTo.replace(/'/g, '')

  // See note in fetchPosthogSourcesByBucket: the parens around BETWEEN are
  // load-bearing because HogQL's AND binds tighter than BETWEEN.
  const hogql = `SELECT ${timeExpr} AS bucket, count() FROM events WHERE event = '${safeEvent}' AND (toDate(timestamp, '${tzLit}') BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY bucket ORDER BY bucket`

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
