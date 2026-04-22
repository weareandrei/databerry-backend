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
  userUri: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<string> {
  const events = await getEventsInRange(token, userUri, dateFrom, dateTo)
  return String(events.length)
}

/**
 * Back-compat wrapper for today's meeting count.
 */
export async function computeMeetingsToday(token: string, userUri: string): Promise<string> {
  return computeMeetingsRange(token, userUri)
}

/**
 * Fetch all scheduled events in [dateFrom, dateTo] (inclusive, UTC days).
 */
export async function getEventsInRange(
  token: string,
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
    const body = await res.json().catch(() => ({}))
    throw new Error('Calendly API error: ' + JSON.stringify(body))
  }

  const data = (await res.json()) as { collection: Record<string, unknown>[] }
  return data.collection
}

/**
 * Back-compat wrapper — today's events only.
 */
export async function getTodayEvents(
  token: string,
  userUri: string,
): Promise<Record<string, unknown>[]> {
  return getEventsInRange(token, userUri)
}
