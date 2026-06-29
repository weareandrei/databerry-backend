import { Logger } from '@nestjs/common'
import { localMidnightUtc } from '../../../common/tz'
import { CalendlyApiClient } from '../../calendly-api.client'

export interface CalendlyMeeting {
  startTime: string
  endTime: string
  name: string
  bookingUri: string
  invitees: { name: string; email: string }[]
  description: string | null
}

function dayStart(dateStr: string | undefined, tz: string): Date {
  if (!dateStr) {
    const now = new Date()
    const todayStr = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`
    return localMidnightUtc(todayStr, tz)
  }
  return localMidnightUtc(dateStr, tz)
}

function dayAfter(dateStr: string | undefined, tz: string): Date {
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

export async function computeMeetingsToday(
  token: string,
  connectionId: string,
  userUri: string,
  tz: string = 'UTC',
): Promise<string> {
  return computeMeetingsRange(token, connectionId, userUri, undefined, undefined, tz)
}

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

  return new CalendlyApiClient(token, connectionId).listScheduledEvents({
    userUri,
    minStartTime: min.toISOString(),
    maxStartTime: max.toISOString(),
  })
}

export async function getTodayEvents(
  token: string,
  connectionId: string,
  userUri: string,
  tz: string = 'UTC',
): Promise<Record<string, unknown>[]> {
  return getEventsInRange(token, connectionId, userUri, undefined, undefined, tz)
}

/**
 * calendly_meetings_list
 * Returns full meeting details (with invitees) for all active events in
 * [dateFrom, dateTo]. Day boundaries are evaluated in `tz` (default UTC).
 */
export async function computeMeetingsList(
  token: string,
  connectionId: string,
  userUri: string,
  logger: Logger,
  dateFrom?: string,
  dateTo?: string,
  tz: string = 'UTC',
): Promise<CalendlyMeeting[]> {
  const events = await getEventsInRange(token, connectionId, userUri, dateFrom, dateTo, tz)
  const apiClient = new CalendlyApiClient(token, connectionId)
  const meetings: CalendlyMeeting[] = []

  for (const event of events) {
    const uri = event.uri as string
    const uuid = uri.split('/').pop()!

    let invitees: { name: string; email: string }[] = []
    try {
      invitees = await apiClient.listInvitees(uuid)
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
