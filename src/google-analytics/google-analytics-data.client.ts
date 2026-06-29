import { Logger, NotFoundException } from '@nestjs/common'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../common/integration-errors'
import { fmtOp, fmtUpstreamFailure, truncate } from '../common/log-helpers'
import type { BucketGranularity } from '../common/types'

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'
const logger = new Logger('GoogleAnalyticsDataClient')

export type { BucketGranularity }

export interface SourceBucketRow {
  bucketKey: string
  source: string
  value: number
}

export interface GAPageRow {
  path: string
  pageviews: number
  visitors: number
}

type ReportRow = {
  dimensionValues?: { value: string }[]
  metricValues?: { value: string }[]
}

function isServiceDisabledBody(body: string): boolean {
  return body.includes('SERVICE_DISABLED')
}

function extractActivationUrl(body: string): string | undefined {
  return body.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/[^"\s]+/)?.[0]
}

/**
 * Authenticated HTTP client for the GA Data API. One instance per access
 * token + connection — never a Nest singleton.
 */
export class GoogleAnalyticsDataClient {
  constructor(
    private readonly accessToken: string,
    private readonly connectionId: string,
  ) {}

  async runReport(
    propertyId: string,
    body: Record<string, unknown>,
  ): Promise<{ rows?: ReportRow[] }> {
    const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) await this.throwForResponse(res, 'GA Data API error')
    return (await res.json()) as { rows?: ReportRow[] }
  }

  async runRealtimeReport(
    propertyId: string,
    body: Record<string, unknown>,
  ): Promise<{ rows?: ReportRow[] }> {
    const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runRealtimeReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) await this.throwForResponse(res, 'GA Realtime API error')
    return (await res.json()) as { rows?: ReportRow[] }
  }

  async fetchRealtimeActiveUsers(propertyId: string): Promise<string> {
    const data = await this.runRealtimeReport(propertyId, {
      metrics: [{ name: 'activeUsers' }],
    })
    return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
  }

  async fetchTodayMetric(
    propertyId: string,
    metricName: string,
    dateFrom = 'today',
    dateTo = dateFrom,
  ): Promise<string> {
    const data = await this.runReport(propertyId, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      metrics: [{ name: metricName }],
    })
    return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
  }

  async fetchSourcesByBucket(
    propertyId: string,
    dateFrom: string,
    dateTo: string,
    granularity: BucketGranularity,
  ): Promise<SourceBucketRow[]> {
    const timeDimension = granularity === 'hourly' ? 'dateHour' : 'date'
    const data = await this.runReport(propertyId, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: 'sessionSource' }, { name: timeDimension }],
      metrics: [{ name: 'totalUsers' }],
      limit: 10000,
    })
    return (data.rows ?? []).map(row => ({
      source: row.dimensionValues![0].value,
      bucketKey: row.dimensionValues![1].value,
      value: parseInt(row.metricValues![0].value, 10) || 0,
    }))
  }

  async fetchVisitorsTotal(
    propertyId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<number> {
    const data = await this.runReport(propertyId, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      metrics: [{ name: 'totalUsers' }],
    })
    return parseInt(data.rows?.[0]?.metricValues?.[0]?.value ?? '0', 10) || 0
  }

  async fetchPagesList(
    propertyId: string,
    dateFrom: string,
    dateTo: string,
    limit: number,
  ): Promise<GAPageRow[]> {
    const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)))
    const data = await this.runReport(propertyId, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: safeLimit,
    })
    return (data.rows ?? []).map(row => ({
      path: row.dimensionValues![0].value,
      pageviews: parseInt(row.metricValues![0].value, 10) || 0,
      visitors: parseInt(row.metricValues![1].value, 10) || 0,
    }))
  }

  async fetchMetricByBucket(
    propertyId: string,
    metricName: string,
    dateFrom: string,
    dateTo: string,
    granularity: BucketGranularity,
  ): Promise<{ bucketKey: string; value: number }[]> {
    const timeDimension = granularity === 'hourly' ? 'dateHour' : 'date'
    const data = await this.runReport(propertyId, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: timeDimension }],
      metrics: [{ name: metricName }],
      limit: 10000,
    })
    return (data.rows ?? []).map(row => ({
      bucketKey: row.dimensionValues![0].value,
      value: parseFloat(row.metricValues![0].value) || 0,
    }))
  }

  private async throwForResponse(res: Response, context: string): Promise<never> {
    const body = await res.text().catch(() => '')

    if (res.status === 403 && isServiceDisabledBody(body)) {
      const activationUrl = extractActivationUrl(body)
      logger.warn(
        fmtOp('GA Data API is disabled in the OAuth Cloud project', {
          connectionId: this.connectionId,
          context,
          ...(activationUrl ? { enableAt: activationUrl } : {}),
        }),
      )
      throw new IntegrationUpstreamException(
        'google_analytics',
        this.connectionId,
        `${context}: Data API not enabled. Enable at: ${activationUrl ?? 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com'}`,
      )
    }

    logger.warn(fmtUpstreamFailure(context, res.status, body, { connectionId: this.connectionId }))
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationReauthRequiredException(
        'google_analytics',
        this.connectionId,
        `${context}: ${truncate(body, 200)}`,
      )
    }
    throw new IntegrationUpstreamException(
      'google_analytics',
      this.connectionId,
      `${context} (${res.status}): ${truncate(body, 200)}`,
    )
  }
}

/** Maps a GA view type to the GA Data API metric name. */
export function metricForViewType(viewType: string): string {
  switch (viewType) {
    case 'ga_users_today':
      return 'totalUsers'
    case 'ga_sessions_today':
      return 'sessions'
    case 'ga_pageviews_today':
      return 'screenPageViews'
    default:
      throw new NotFoundException(`Unknown GA view type: ${viewType}`)
  }
}
