import { Logger, NotFoundException } from '@nestjs/common'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../../common/integration-errors'

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'
const logger = new Logger('GoogleAnalyticsDataAPI')

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
 * Translate a non-OK response from the GA Data API into the right
 * structured exception. 401/403 → user must reconnect (refresh succeeded
 * but the granted access is gone, e.g. revoked at the property level).
 * Anything else → upstream failure: 404 (property not found), 429 (quota),
 * 5xx (Google outage). Calling these "Unauthorized" — as the previous code
 * did — was misleading the frontend into showing reauth UX for transient
 * problems that reconnecting wouldn't fix.
 */
async function throwForResponse(
  connectionId: string,
  res: Response,
  context: string,
): Promise<never> {
  const body = await res.text().catch(() => '')
  // Log here so the Google response body lands in the GA log stream alongside
  // ensureFreshToken's logs — instead of relying on whichever upstream filter
  // happens to print the exception message.
  logger.warn(
    `${context} for ${connectionId}: status=${res.status} body=${body.slice(0, 200)}`,
  )
  if (res.status === 401 || res.status === 403) {
    throw new IntegrationReauthRequiredException(
      'google_analytics',
      connectionId,
      `${context}: ${body.slice(0, 200)}`,
    )
  }
  throw new IntegrationUpstreamException(
    'google_analytics',
    connectionId,
    `${context} (${res.status}): ${body.slice(0, 200)}`,
  )
}

/**
 * ga_active_users
 * Returns the current number of active users via the Realtime API.
 */
export async function fetchRealtimeActiveUsers(
  token: string,
  connectionId: string,
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
  if (!res.ok) await throwForResponse(connectionId, res, 'GA Realtime API error')
  const data = (await res.json()) as {
    rows?: { metricValues: { value: string }[] }[]
  }
  return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
}

/**
 * ga_users_today / ga_sessions_today / ga_pageviews_today
 * Returns the cumulative value for the given metric on a date range via the Data API.
 * Accepts any YYYY-MM-DD date strings or 'today'.
 *
 * No `tz` parameter — the GA4 Data API's `RunReportRequest` schema has
 * no per-request `timeZone` field. Reports always evaluate `dateRanges`
 * in the *property's* timezone (set in GA Admin → Property settings).
 * If property tz ≠ user tz, "today" boundaries can disagree by an hour
 * or two from the user's wall clock — `project-overview.service` logs
 * a warning when it spots that mismatch. A full fix would require us
 * to switch to the `dateHourMinute` dimension and bucket on our side.
 */
export async function fetchTodayMetric(
  token: string,
  connectionId: string,
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
  if (!res.ok) await throwForResponse(connectionId, res, `GA Data API error (${metricName})`)
  const data = (await res.json()) as {
    rows?: { metricValues: { value: string }[] }[]
  }
  return data.rows?.[0]?.metricValues?.[0]?.value ?? '0'
}
