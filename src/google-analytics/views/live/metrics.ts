import { Logger, NotFoundException } from '@nestjs/common'
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

/**
 * Google returns a 403 with `reason: "SERVICE_DISABLED"` when the Data
 * API (`analyticsdata.googleapis.com`) is not enabled in the Cloud project
 * that owns the OAuth client. This is DIFFERENT from the Admin API
 * (`analyticsadmin.googleapis.com`) — they're enabled separately, so a
 * user who enabled Admin (so they could pick a property) often still
 * hits this on the first dashboard load.
 *
 * Crucially, this is NOT a credential problem — reconnecting the
 * integration won't fix it; the user needs to click "Enable" in the
 * Google Cloud Console. Surfacing it as `IntegrationReauthRequired`
 * (the old behaviour) was misleading them into an OAuth re-dance that
 * landed them right back in the same broken state.
 */
function isServiceDisabledBody(body: string): boolean {
  return body.includes('SERVICE_DISABLED')
}

function extractActivationUrl(body: string): string | undefined {
  return body.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/[^"\s]+/)?.[0]
}

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
 * structured exception.
 *   401, or 403 without SERVICE_DISABLED → real auth failure; user must
 *     reconnect (refresh succeeded but the granted access is gone, e.g.
 *     property revoked).
 *   403 with SERVICE_DISABLED → Data API not enabled in the Cloud
 *     project. NOT a credential issue — surface as upstream so the
 *     frontend doesn't render the misleading "Reconnect" banner.
 *   Anything else → upstream failure: 404 (property not found), 429
 *     (quota), 5xx (Google outage).
 *
 * Calling everything "Unauthorized" — as the very first version of this
 * code did — flooded the frontend with reauth UX for transient
 * problems that reconnecting wouldn't fix. This is the second pass at
 * that classification.
 */
async function throwForResponse(
  connectionId: string,
  res: Response,
  context: string,
): Promise<never> {
  const body = await res.text().catch(() => '')

  if (res.status === 403 && isServiceDisabledBody(body)) {
    const activationUrl = extractActivationUrl(body)
    // Single actionable log line — the user (reading Railway logs) sees
    // exactly what's broken and where to fix it without parsing the
    // Google JSON. Same shape as the Admin API hint in `connection/oauth.ts`.
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

  logger.warn(
    fmtUpstreamFailure(context, res.status, body, { connectionId }),
  )
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
