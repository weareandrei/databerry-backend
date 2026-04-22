import { NotFoundException, UnauthorizedException } from '@nestjs/common'

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'

/**
 * Maps a GA view type to the GA Data API metric name.
 */
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

/**
 * ga_active_users
 * Returns the current number of active users via the Realtime API.
 */
export async function fetchRealtimeActiveUsers(
  token: string,
  propertyId: string,
): Promise<string> {
  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runRealtimeReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new UnauthorizedException(`GA Realtime API error: ${body}`)
  }
  const data = (await res.json()) as {
    rows?: { metricValues: { value: string }[] }[]
  }
  return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
}

/**
 * ga_users_today / ga_sessions_today / ga_pageviews_today
 * Returns the cumulative value for the given metric on a date range via the Data API.
 * Accepts any YYYY-MM-DD date strings or 'today'.
 */
export async function fetchTodayMetric(
  token: string,
  propertyId: string,
  metricName: string,
  dateFrom = 'today',
  dateTo = dateFrom,
): Promise<string> {
  const res = await fetch(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      metrics: [{ name: metricName }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new UnauthorizedException(`GA Data API error: ${body}`)
  }
  const data = (await res.json()) as {
    rows?: { metricValues: { value: string }[] }[]
  }
  return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
}
