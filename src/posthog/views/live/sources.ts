import { Logger } from '@nestjs/common'
import type { PosthogCredentials } from '../../connection/credentials'

export type BucketGranularity = 'hourly' | 'daily'

export interface SourceBucketRow {
  bucketKey: string
  source: string
  value: number
}

/**
 * Posthog sources-by-bucket (via HogQL).
 * bucketKey format: "YYYY-MM-DD HH:00:00" for hourly, "YYYY-MM-DD" for daily.
 */
export async function fetchPosthogSourcesByBucket(
  ph: PosthogCredentials,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
): Promise<SourceBucketRow[]> {
  const timeExpr =
    granularity === 'hourly'
      ? "toStartOfHour(timestamp)"
      : "toDate(timestamp)"

  const safeFrom = dateFrom.replace(/'/g, '')
  const safeTo = dateTo.replace(/'/g, '')

  // `$initial_referring_domain` is the standard Posthog property for session source.
  const hogql = `SELECT ${timeExpr} AS bucket, properties.$initial_referring_domain AS src, count() FROM events WHERE event = '$pageview' AND toDate(timestamp) BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}') GROUP BY bucket, src ORDER BY bucket`

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
 */
export async function fetchPosthogEventCountByBucket(
  ph: PosthogCredentials,
  eventName: string,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
  logger: Logger,
): Promise<{ bucketKey: string; value: number }[]> {
  const timeExpr =
    granularity === 'hourly' ? "toStartOfHour(timestamp)" : "toDate(timestamp)"

  const safeEvent = eventName.replace(/'/g, "\\'")
  const safeFrom = dateFrom.replace(/'/g, '')
  const safeTo = dateTo.replace(/'/g, '')

  const hogql = `SELECT ${timeExpr} AS bucket, count() FROM events WHERE event = '${safeEvent}' AND toDate(timestamp) BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}') GROUP BY bucket ORDER BY bucket`

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
