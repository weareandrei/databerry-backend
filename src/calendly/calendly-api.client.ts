import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../common/integration-errors'

const BASE_API = 'https://api.calendly.com'

export interface CalendlyMe {
  uri: string
  current_organization: string
}

export interface CalendlyInvitee {
  name: string
  email: string
}

/**
 * Authenticated HTTP client for the Calendly REST API. One instance per
 * access token + connection — never a Nest singleton.
 */
export class CalendlyApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly connectionId: string,
  ) {}

  async getMe(): Promise<CalendlyMe> {
    const res = await fetch(`${BASE_API}/users/me`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new CalendlyApiHttpError('getMe', res.status, body)
    }
    const data = (await res.json()) as { resource: CalendlyMe }
    return data.resource
  }

  async listScheduledEvents(params: {
    userUri: string
    minStartTime: string
    maxStartTime: string
    status?: string
    count?: number
  }): Promise<Record<string, unknown>[]> {
    const url = new URL(`${BASE_API}/scheduled_events`)
    url.searchParams.set('user', params.userUri)
    url.searchParams.set('min_start_time', params.minStartTime)
    url.searchParams.set('max_start_time', params.maxStartTime)
    url.searchParams.set('status', params.status ?? 'active')
    url.searchParams.set('count', String(params.count ?? 100))

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        throw new IntegrationReauthRequiredException(
          'calendly',
          this.connectionId,
          `Calendly API: ${body.slice(0, 200)}`,
        )
      }
      throw new IntegrationUpstreamException(
        'calendly',
        this.connectionId,
        `Calendly API (${res.status}): ${body.slice(0, 200)}`,
      )
    }

    const data = (await res.json()) as { collection: Record<string, unknown>[] }
    return data.collection
  }

  async listInvitees(eventUuid: string): Promise<CalendlyInvitee[]> {
    const res = await fetch(`${BASE_API}/scheduled_events/${eventUuid}/invitees`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { collection: CalendlyInvitee[] }
    return data.collection.map(inv => ({ name: inv.name, email: inv.email }))
  }
}

class CalendlyApiHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Calendly API ${operation} failed (${status})`)
    this.name = 'CalendlyApiHttpError'
  }
}
