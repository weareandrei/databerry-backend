import { Logger } from '@nestjs/common'
import { escapeDateLiteral, tzDateBucket } from './hogql-utils'
import type { PosthogCredentials } from '../../connection/credentials'

export interface PosthogCountryRow {
  /**
   * ISO 3166-1 alpha-2 country code from PostHog's geoip enrichment
   * (`$geoip_country_code`). Used as the stable join key + as the input
   * for flag rendering (e.g. 'US', 'GB', 'DE'). May be empty/null when
   * geoip didn't resolve the visitor's IP — handled at the call site.
   */
  countryCode: string
  /** Human-readable name from `$geoip_country_name`. May be empty. */
  countryName: string
  /** Distinct visitor (distinct_id) count from this country in the range. */
  visitors: number
}

/**
 * Per-country aggregation of distinct visitors from `$pageview` events
 * in the given range, ordered by visitor count desc.
 *
 * Mirrors `fetchPosthogSourcesByBucket`'s shape but groups by PostHog's
 * geoip-resolved country code instead of `$initial_referring_domain`.
 * The geoip enrichment is set by PostHog on event ingest (no client SDK
 * config needed), so any project that's been sending pageviews has
 * country data automatically.
 *
 * Rows with an unresolved country (private IPs, VPNs that scrub headers,
 * misconfigured proxies) are excluded via the `IS NOT NULL` guard so
 * the Countries panel doesn't have to render a meaningless "?" row.
 * They still count toward Sources totals — only the geoip slice is
 * affected.
 */
export async function fetchPosthogCountriesList(
  ph: PosthogCredentials,
  dateFrom: string,
  dateTo: string,
  limit: number,
  logger: Logger,
  tz: string = 'UTC',
): Promise<PosthogCountryRow[]> {
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)
  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)))
  const tzDate = tzDateBucket(tz)

  // GROUP BY on the property reference itself; `any(...)` on the
  // country *name* because it's denormalised per-event and we just
  // need one representative value per code. Parens around BETWEEN are
  // load-bearing — see fetchPosthogSourcesByBucket for the precedence
  // bug story.
  const hogql = `SELECT properties.$geoip_country_code AS country_code, any(properties.$geoip_country_name) AS country_name, count(distinct distinct_id) AS visitors FROM events WHERE event = '$pageview' AND properties.$geoip_country_code IS NOT NULL AND properties.$geoip_country_code != '' AND (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY properties.$geoip_country_code ORDER BY visitors DESC LIMIT ${safeLimit}`

  const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error(`PostHog countries query failed: ${body}`)
    return []
  }

  const json = (await res.json()) as {
    results?: [string | null, string | null, number | string][]
  }

  const rows: PosthogCountryRow[] = []
  for (const [code, name, visitors] of json.results ?? []) {
    if (!code) continue
    rows.push({
      countryCode: String(code).toUpperCase(),
      countryName: String(name ?? ''),
      visitors: Number(visitors) || 0,
    })
  }
  return rows
}
