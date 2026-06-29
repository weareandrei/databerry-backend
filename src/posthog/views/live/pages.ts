import { Logger } from '@nestjs/common'
import { escapeDateLiteral, tzDateBucket } from './hogql-utils'
import { PosthogApiClient } from '../../posthog-api.client'

export interface PosthogPageRow {
  /** URL path, e.g. "/hub/onboarding". */
  path: string
  /** Raw `$pageview` event count for this path in range. */
  pageviews: number
  /** Unique people (merged person identity) who viewed it. */
  visitors: number
}

/**
 * Top pages by pageview count — powers the overview panel's "Pages"
 * tab. Mirrors `fetchPosthogCountriesList`'s shape: one aggregated
 * list query over `$pageview` events, bounded in the user's tz.
 *
 * Both counts come back per path so the UI can show "how many views"
 * (the headline, per the product definition: pageviews = how many
 * pages were viewed, regardless of who) alongside "by how many
 * people" without a second query.
 *
 * `$pathname` is PostHog's auto-captured path property. Rows with a
 * missing/empty path (custom events mislabelled as pageviews, very
 * old SDKs) are excluded — a blank row tells the user nothing.
 */
export async function fetchPosthogPagesList(
  client: PosthogApiClient,
  dateFrom: string,
  dateTo: string,
  limit: number,
  logger: Logger,
  tz: string = 'UTC',
): Promise<PosthogPageRow[]> {
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)
  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)))
  const tzDate = tzDateBucket(tz)

  // Parens around BETWEEN are load-bearing — see
  // fetchPosthogSourcesByBucket for the precedence bug story.
  const hogql = `SELECT properties.$pathname AS path, count() AS pageviews, count(DISTINCT person_id) AS visitors FROM events WHERE event = '$pageview' AND properties.$pathname IS NOT NULL AND properties.$pathname != '' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY path ORDER BY pageviews DESC LIMIT ${safeLimit}`

  try {
    const json = (await client.queryHogql(hogql)) as {
      results?: [string | null, number | string, number | string][]
    }

    const rows: PosthogPageRow[] = []
    for (const [path, pageviews, visitors] of json.results ?? []) {
      if (!path) continue
      rows.push({
        path: String(path),
        pageviews: Number(pageviews) || 0,
        visitors: Number(visitors) || 0,
      })
    }
    return rows
  } catch (err) {
    logger.error(`PostHog pages query failed: ${String(err)}`)
    return []
  }
}
