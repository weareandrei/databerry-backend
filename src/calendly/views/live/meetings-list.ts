import { Logger } from '@nestjs/common'
import { getEventsInRange } from './meetings-today'

const BASE_API = 'https://api.calendly.com'

export interface CalendlyMeeting {
  startTime: string
  endTime: string
  name: string
  bookingUri: string
  invitees: { name: string; email: string }[]
  description: string | null
}

/**
 * calendly_meetings_list
 * Returns full meeting details (with invitees) for all active events in [dateFrom, dateTo].
 * When both args are omitted, returns today's events (UTC).
 */
export async function computeMeetingsList(
  token: string,
  connectionId: string,
  userUri: string,
  logger: Logger,
  dateFrom?: string,
  dateTo?: string,
): Promise<CalendlyMeeting[]> {
  const events = await getEventsInRange(token, connectionId, userUri, dateFrom, dateTo)
  const meetings: CalendlyMeeting[] = []

  for (const event of events) {
    const uri = event.uri as string
    const uuid = uri.split('/').pop()!

    let invitees: { name: string; email: string }[] = []
    try {
      const inviteesRes = await fetch(`${BASE_API}/scheduled_events/${uuid}/invitees`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (inviteesRes.ok) {
        const inviteesData = (await inviteesRes.json()) as {
          collection: { name: string; email: string }[]
        }
        invitees = inviteesData.collection.map(inv => ({ name: inv.name, email: inv.email }))
      }
    } catch {
      logger.warn(`Failed to fetch invitees for event ${uuid}`)
    }

    meetings.push({
      startTime: event.start_time as string,
      endTime: event.end_time as string,
      name: event.name as string,
      bookingUri: uri,
      invitees,
      description: (event.description ?? null) as string | null,
    })
  }

  return meetings
}
