import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../../common/integration-errors'

const BASE_API = 'https://api.calendly.com'

function dayStart(dateStr?: string): Date {
  const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function dayAfter(dateStr?: string): Date {
  const d = dayStart(dateStr)
  d.setUTCDate(d.getUTCDate() + 1)
  return d
}

/**
 * Returns the count of active scheduled events for a date range.
 * When both args are omitted, counts today (UTC) — same as the old `computeMeetingsToday` behaviour.
 */
export async function computeMeetingsRange(
  token: string,
  connectionId: string,
  userUri: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<string> {
  const events = await getEventsInRange(token, connectionId, userUri, dateFrom, dateTo)
  return String(events.length)
}

/**
 * Back-compat wrapper for today's meeting count.
 */
export async function computeMeetingsToday(
  token: string,
  connectionId: string,
  userUri: string,
): Promise<string> {
  return computeMeetingsRange(token, connectionId, userUri)
}

/**
 * Fetch all scheduled events in [dateFrom, dateTo] (inclusive, UTC days).
 */
export async function getEventsInRange(
  token: string,
  connectionId: string,
  userUri: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<Record<string, unknown>[]> {
  const min = dayStart(dateFrom)
  const max = dayAfter(dateTo ?? dateFrom)

  const url = new URL(`${BASE_API}/scheduled_events`)
  url.searchParams.set('user', userUri)
  url.searchParams.set('min_start_time', min.toISOString())
  url.searchParams.set('max_start_time', max.toISOString())
  url.searchParams.set('status', 'active')
  url.searchParams.set('count', '100')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 401 here is unusual (we just refreshed) but real — it can happen if
    // the user's Calendly account was disabled, or the org membership
    // changed. Surface as reauth so the user gets the right prompt.
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationReauthRequiredException(
        'calendly',
        connectionId,
        `Calendly API: ${body.slice(0, 200)}`,
      )
    }
    throw new IntegrationUpstreamException(
      'calendly',
      connectionId,
      `Calendly API (${res.status}): ${body.slice(0, 200)}`,
    )
  }

  const data = (await res.json()) as { collection: Record<string, unknown>[] }
  return data.collection
}

/**
 * Back-compat wrapper — today's events only.
 */
export async function getTodayEvents(
  token: string,
  connectionId: string,
  userUri: string,
): Promise<Record<string, unknown>[]> {
  return getEventsInRange(token, connectionId, userUri)
}
