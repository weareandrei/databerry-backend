import { Logger } from '@nestjs/common'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../common/integration-errors'

const BASE_API = 'https://sentry.io/api/0'
const logger = new Logger('SentryApiClient')

export interface SentryIssue {
  id: string
  title: string
  count: string
  level: 'error' | 'warning' | 'info' | 'debug' | 'fatal' | string
  status: 'unresolved' | 'resolved' | 'ignored' | string
  firstSeen: string
  lastSeen: string
  permalink: string
}

export type IssuesPeriod = '24h' | '7d' | '30d' | '90d'
export type IssuesSort = 'recent' | 'frequent'

/**
 * Authenticated HTTP client for the Sentry REST API. One instance per
 * access token + connection — never a Nest singleton.
 */
export class SentryApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly connectionId: string,
  ) {}

  async listIssues(
    orgSlug: string,
    period: IssuesPeriod = '24h',
    sort: IssuesSort = 'recent',
  ): Promise<SentryIssue[]> {
    const sentrySort = sort === 'frequent' ? 'freq' : 'new'

    const url = new URL(`${BASE_API}/organizations/${orgSlug}/issues/`)
    url.searchParams.set('statsPeriod', period)
    url.searchParams.set('sort', sentrySort)
    url.searchParams.set('limit', '25')
    url.searchParams.set('query', 'is:unresolved')

    let res: Response
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      })
    } catch (err) {
      logger.warn(`Sentry issues fetch network error for ${this.connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'sentry',
        this.connectionId,
        'Could not reach Sentry API',
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        logger.warn(
          `Sentry issues 401/403 for ${this.connectionId}: ${detail.slice(0, 200)}`,
        )
        throw new IntegrationReauthRequiredException(
          'sentry',
          this.connectionId,
          `Sentry API ${res.status}: ${detail.slice(0, 200)}`,
        )
      }
      logger.warn(
        `Sentry issues upstream ${res.status} for ${this.connectionId}: ${detail.slice(0, 200)}`,
      )
      throw new IntegrationUpstreamException(
        'sentry',
        this.connectionId,
        `Sentry API ${res.status}`,
      )
    }

    const raw = (await res.json()) as Array<{
      id: string
      title: string
      count: string
      level: string
      status: string
      firstSeen: string
      lastSeen: string
      permalink: string
    }>

    return raw.map(r => ({
      id: r.id,
      title: r.title,
      count: r.count,
      level: r.level,
      status: r.status,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      permalink: r.permalink,
    }))
  }
}
