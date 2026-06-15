import { Logger } from '@nestjs/common'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../../common/integration-errors'
import {
  fmtOp,
  fmtUpstreamFailure,
  truncate,
} from '../../../common/log-helpers'

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'
const logger = new Logger('GoogleAnalyticsDataAPI')

import type { BucketGranularity } from '../../../common/types'
export type { BucketGranularity }

export interface SourceBucketRow {
  bucketKey: string // "YYYYMMDDHH" for hourly, "YYYYMMDD" for daily
  source: string
  value: number
}

/**
 * Translate non-OK responses into the structured integration exceptions.
 *   401, or 403 without SERVICE_DISABLED → reauth required.
 *   403 with SERVICE_DISABLED → Data API not enabled in the Cloud
 *     project. NOT a credential issue (reconnecting won't fix it) —
 *     surface as upstream + emit a one-line actionable log with the
 *     activation URL. See `metrics.ts` for the full rationale and the
 *     Admin-vs-Data API split.
 *   Everything else → upstream error.
 *
 * The previous code wrapped EVERY non-OK as `UnauthorizedException`,
 * which made transient property/quota errors look like auth failures
 * to the frontend.
 */
async function throwForResponse(
  connectionId: string,
  res: Response,
  context: string,
): Promise<never> {
  const body = await res.text().catch(() => '')

  if (res.status === 403 && body.includes('SERVICE_DISABLED')) {
    const activationUrl = body.match(
      /https:\/\/console\.developers\.google\.com\/apis\/api\/[^"\s]+/,
    )?.[0]
    logger.warn(
      fmtOp('GA Data API is disabled in the OAuth Cloud project', {
        connectionId,
        context,
        ...(activationUrl ? { enableAt: activationUrl } : {}),
      }),
    )
    throw new IntegrationUpstreamException(
      'google_analytics',
      connectionId,
      `${context}: Data API not enabled. Enable at: ${activationUrl ?? 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com'}`,
    )
  }

  logger.warn(fmtUpstreamFailure(context, res.status, body, { connectionId }))
  if (res.status === 401 || res.status === 403) {
    throw new IntegrationReauthRequiredException(
      'google_analytics',
      connectionId,
      `${context}: ${truncate(body, 200)}`,
    )
  }
  throw new IntegrationUpstreamException(
    'google_analytics',
    connectionId,
    `${context} (${res.status}): ${truncate(body, 200)}`,
  )
}

/**
 * Fetches UNIQUE VISITORS (`totalUsers`) grouped by session source and
 * time bucket. Uses `dateHour` dimension for Daily mode (hourly
 * buckets) and `date` for Weekly/Monthly.
 *
 * Was `sessions` — swapped to `totalUsers` as part of the
 * visitors-vs-pageviews disambiguation: the overview chart labels
 * this series "Visitors", so it must count people, not sessions
 * (one person bouncing in three times a day inflated "visitors" by
 * 3× and never reconciled with PostHog-backed projects).
 */
export async function fetchSourcesByBucket(
  token: string,
  connectionId: string,
  propertyId: string,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
): Promise<SourceBucketRow[]> {
  const timeDimension = granularity === 'hourly' ? 'dateHour' : 'date'

  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: 'sessionSource' }, { name: timeDimension }],
      metrics: [{ name: 'totalUsers' }],
      limit: 10000,
    }),
  })

  if (!res.ok) await throwForResponse(connectionId, res, 'GA Data API error (sources)')

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]
  }

  return (data.rows ?? []).map(row => ({
    source: row.dimensionValues[0].value,
    bucketKey: row.dimensionValues[1].value,
    value: parseInt(row.metricValues[0].value, 10) || 0,
  }))
}

/**
 * Range-wide UNIQUE visitor count — `totalUsers` over [from, to] with
 * NO date dimension, so GA dedupes once across the whole window.
 *
 * Same reasoning as the PostHog `fetchPosthogVisitorsTotal`: summing
 * the per-bucket `totalUsers` from `fetchSourcesByBucket` double-counts
 * anyone active in more than one bucket, inflating the chart's headline
 * "Visitors" total above the real number of people. This single
 * dimensionless report is the honest deduped total.
 */
export async function fetchVisitorsTotal(
  token: string,
  connectionId: string,
  propertyId: string,
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      metrics: [{ name: 'totalUsers' }],
    }),
  })

  if (!res.ok) await throwForResponse(connectionId, res, 'GA Data API error (visitors total)')

  const data = (await res.json()) as {
    rows?: { metricValues: { value: string }[] }[]
  }
  return parseInt(data.rows?.[0]?.metricValues[0]?.value ?? '0', 10) || 0
}

export interface GAPageRow {
  path: string
  pageviews: number
  visitors: number
}

/**
 * Top pages by pageview count — GA flavour of the overview panel's
 * "Pages" tab. One `runReport` over `pagePath` with both counts so
 * the UI can show views + unique people per path without a second
 * round-trip. Server-side ordered by pageviews desc.
 */
export async function fetchPagesList(
  token: string,
  connectionId: string,
  propertyId: string,
  dateFrom: string,
  dateTo: string,
  limit: number,
): Promise<GAPageRow[]> {
  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)))

  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: safeLimit,
    }),
  })

  if (!res.ok) await throwForResponse(connectionId, res, 'GA Data API error (pages)')

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]
  }

  return (data.rows ?? []).map(row => ({
    path: row.dimensionValues[0].value,
    pageviews: parseInt(row.metricValues[0].value, 10) || 0,
    visitors: parseInt(row.metricValues[1].value, 10) || 0,
  }))
}

/**
 * Fetches a single metric (screenPageViews / bounceRate / averageSessionDuration / sessions / totalUsers)
 * grouped by time bucket only (no source split).
 */
export async function fetchMetricByBucket(
  token: string,
  connectionId: string,
  propertyId: string,
  metricName: string,
  dateFrom: string,
  dateTo: string,
  granularity: BucketGranularity,
): Promise<{ bucketKey: string; value: number }[]> {
  const timeDimension = granularity === 'hourly' ? 'dateHour' : 'date'

  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: timeDimension }],
      metrics: [{ name: metricName }],
      limit: 10000,
    }),
  })

  if (!res.ok) await throwForResponse(connectionId, res, `GA Data API error (${metricName})`)

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]
  }

  return (data.rows ?? []).map(row => ({
    bucketKey: row.dimensionValues[0].value,
    value: parseFloat(row.metricValues[0].value) || 0,
  }))
}
