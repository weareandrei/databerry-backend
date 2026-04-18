const BASE_API = 'https://api.calendly.com'

/**
 * calendly_meetings_today
 * Returns the count of active scheduled events for today (UTC).
 */
export async function computeMeetingsToday(token: string, userUri: string): Promise<string> {
  const events = await getTodayEvents(token, userUri)
  return String(events.length)
}

export async function getTodayEvents(
  token: string,
  userUri: string,
): Promise<Record<string, unknown>[]> {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setUTCHours(23, 59, 59, 999)

  const url = new URL(`${BASE_API}/scheduled_events`)
  url.searchParams.set('user', userUri)
  url.searchParams.set('min_start_time', todayStart.toISOString())
  url.searchParams.set('max_start_time', todayEnd.toISOString())
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
