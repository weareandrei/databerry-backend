import { Logger } from '@nestjs/common'
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
): Promise<PosthogUserRow[]> {
  const safeFrom = dateFrom.replace(/'/g, '')
  const safeTo = dateTo.replace(/'/g, '')
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))

  // Parens around BETWEEN are load-bearing — see fetchPosthogSourcesByBucket
  // for the precedence-bug story.
  const hogql = `SELECT distinct_id, any(properties.$initial_referring_domain) AS src, dateDiff('second', min(timestamp), max(timestamp)) AS session_sec, max(timestamp) AS last_seen FROM events WHERE event = '$pageview' AND (toDate(timestamp) BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY distinct_id ORDER BY last_seen DESC LIMIT ${safeLimit}`

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
    results?: [string, string | null, number | string, string][]
  }

  const rows: PosthogUserRow[] = []
  for (const [pseudoId, src, sessionSec, lastSeen] of json.results ?? []) {
    rows.push({
      pseudoId: String(pseudoId ?? ''),
      source: src ?? '',
      sessionSec: Number(sessionSec) || 0,
      lastSeen: String(lastSeen ?? ''),
    })
  }
  return rows
}
