import { UnauthorizedException } from '@nestjs/common'

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'

export type BucketGranularity = 'hourly' | 'daily'

export interface SourceBucketRow {
  bucketKey: string // "YYYYMMDDHH" for hourly, "YYYYMMDD" for daily
  source: string
  value: number
}

/**
 * Fetches sessions (activeUsers) grouped by session source and time bucket.
 * Uses `dateHour` dimension for Daily mode (hourly buckets) and `date` dimension for Weekly/Monthly.
 */
export async function fetchSourcesByBucket(
  token: string,
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
      metrics: [{ name: 'sessions' }],
      limit: 10000,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new UnauthorizedException(`GA Data API error (sources): ${body}`)
  }

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
 * Fetches a single metric (screenPageViews / bounceRate / averageSessionDuration / sessions / totalUsers)
 * grouped by time bucket only (no source split).
 */
export async function fetchMetricByBucket(
  token: string,
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

  if (!res.ok) {
    const body = await res.text()
    throw new UnauthorizedException(`GA Data API error (${metricName}): ${body}`)
  }

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]
  }

  return (data.rows ?? []).map(row => ({
    bucketKey: row.dimensionValues[0].value,
    value: parseFloat(row.metricValues[0].value) || 0,
  }))
}
