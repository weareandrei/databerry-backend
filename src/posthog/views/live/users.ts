import { Logger } from '@nestjs/common'
import { escapeDateLiteral, tzDateBucket } from './hogql-utils'
import type { PosthogCredentials } from '../../connection/credentials'

export interface PosthogUserRow {
  /** PostHog `distinct_id` — treat as opaque user pseudo-ID. */
  pseudoId: string
  /** Raw initial referring domain. Normalised downstream. May be empty. */
  source: string
  /** Active-time span for this user inside the range (min→max pageview). */
  sessionSec: number
  /** ISO-8601 timestamp of the user's last pageview in the range. */
  lastSeen: string
  /**
   * ISO 3166-1 alpha-2 from `$geoip_country_code`. Empty when geoip
   * didn't resolve (private IPs, VPN scrubbers, etc.).
   */
  countryCode: string
  /** Display name from `$geoip_country_name`. Empty when not set. */
  countryName: string
  /** City name from `$geoip_city_name`. Empty when not set. */
  city: string
  /**
   * Distinct PostHog session count for this user in the range — count
   * of unique `$session_id` values. PostHog rotates session id every
   * 30 min of inactivity, so this is a reasonable "visits" proxy.
   */
  sessionCount: number
}

/**
 * Per-user aggregation of pageview activity in the given range.
 *
 * We approximate "session time" as the span (max - min timestamp) within the
 * selected window. PostHog's native session model spans whatever event types
 * you configure it to; using the pageview span keeps the numbers consistent
 * with the rest of the Sources tab (both come from `$pageview`).
 *
 * Ordered by most-recent-activity first; capped at `limit` to keep the
 * request bounded.
 */
export async function fetchPosthogUsersList(
  ph: PosthogCredentials,
  dateFrom: string,
  dateTo: string,
  limit: number,
  logger: Logger,
  tz: string = 'UTC',
): Promise<PosthogUserRow[]> {
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const tzDate = tzDateBucket(tz)

  // Parens around BETWEEN are load-bearing — see fetchPosthogSourcesByBucket
  // for the precedence-bug story. `tzDateBucket` handles the `toDate` +
  // `toTimeZone` chain HogQL needs (toDate is single-arg in HogQL).
  // Per-user aggregates added in May 2026 for the standalone
  // `posthog_users` view: geoip (country code/name + city) and a
  // distinct-`$session_id` count. `any(...)` for the geoip fields
  // because they're denormalised per-event and we just want a
  // representative value per user.
  const hogql = `SELECT distinct_id, any(properties.$initial_referring_domain) AS src, dateDiff('second', min(timestamp), max(timestamp)) AS session_sec, max(timestamp) AS last_seen, any(properties.$geoip_country_code) AS country_code, any(properties.$geoip_country_name) AS country_name, any(properties.$geoip_city_name) AS city, count(distinct properties.$session_id) AS session_count FROM events WHERE event = '$pageview' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY distinct_id ORDER BY last_seen DESC LIMIT ${safeLimit}`

  const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error(`PostHog users query failed: ${body}`)
    return []
  }

  const json = (await res.json()) as {
    results?: [
      string,        // distinct_id
      string | null, // src
      number | string, // session_sec
      string,        // last_seen
      string | null, // country_code
      string | null, // country_name
      string | null, // city
      number | string, // session_count
    ][]
  }

  const rows: PosthogUserRow[] = []
  for (const r of json.results ?? []) {
    const [pseudoId, src, sessionSec, lastSeen, countryCode, countryName, city, sessionCount] = r
    rows.push({
      pseudoId: String(pseudoId ?? ''),
      source: src ?? '',
      sessionSec: Number(sessionSec) || 0,
      lastSeen: String(lastSeen ?? ''),
      countryCode: countryCode ? String(countryCode).toUpperCase() : '',
      countryName: countryName ? String(countryName) : '',
      city: city ? String(city) : '',
      sessionCount: Number(sessionCount) || 0,
    })
  }
  return rows
}
