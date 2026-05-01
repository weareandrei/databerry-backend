import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../../common/integration-errors'
import { localMidnightUtc } from '../../../common/tz'

const BASE_API = 'https://api.calendly.com'

/**
 * UTC instant of `dateStr`'s midnight in `tz`. When `dateStr` is omitted we
 * fall back to "today as observed from UTC" — caller-side wrappers
 * (`computeMeetingsRange`) can supply both args to override.
 */
function dayStart(dateStr: string | undefined, tz: string): Date {
  if (!dateStr) {
    const now = new Date()
    const todayStr = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`
    return localMidnightUtc(todayStr, tz)
  }
  return localMidnightUtc(dateStr, tz)
}

function dayAfter(dateStr: string | undefined, tz: string): Date {
  // dayStart, +1 day at the same wall-clock — re-resolve via localMidnightUtc
  // so DST transitions don't drift the bound.
  if (!dateStr) {
    const now = new Date()
    const todayStr = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`
    return localMidnightUtc(addOneDay(todayStr), tz)
  }
  return localMidnightUtc(addOneDay(dateStr), tz)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function addOneDay(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(n => parseInt(n, 10))
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`
}

/**
 * Returns the count of active scheduled events for a date range.
 * When both args are omitted, counts today (in `tz`) — same as the old
 * `computeMeetingsToday` behaviour but tz-aware.
 */
export async function computeMeetingsRange(
  token: string,
  connectionId: string,
  userUri: string,
  dateFrom?: string,
  dateTo?: string,
  tz: string = 'UTC',
): Promise<string> {
  const events = await getEventsInRange(token, connectionId, userUri, dateFrom, dateTo, tz)
  return String(events.length)
}

/**
 * Back-compat wrapper for today's meeting count.
 */
export async function computeMeetingsToday(
  token: string,
  connectionId: string,
  userUri: string,
  tz: string = 'UTC',
): Promise<string> {
  return computeMeetingsRange(token, connectionId, userUri, undefined, undefined, tz)
}

/**
 * Fetch all scheduled events in [dateFrom, dateTo] (inclusive). Day
 * boundaries are evaluated in `tz` — i.e. "Apr 30" means 00:00–24:00 in
 * `tz`, not UTC.
 */
export async function getEventsInRange(
  token: string,
  connectionId: string,
  userUri: string,
  dateFrom?: string,
  dateTo?: string,
  tz: string = 'UTC',
): Promise<Record<string, unknown>[]> {
  const min = dayStart(dateFrom, tz)
  const max = dayAfter(dateTo ?? dateFrom, tz)

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
  tz: string = 'UTC',
): Promise<Record<string, unknown>[]> {
  return getEventsInRange(token, connectionId, userUri, undefined, undefined, tz)
}
