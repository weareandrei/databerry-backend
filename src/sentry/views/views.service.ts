import { Injectable, Logger } from '@nestjs/common'
import { SentryOAuthService } from '../connection/oauth'
import {
  fetchIssuesList,
  type SentryIssue,
  type IssuesPeriod,
  type IssuesSort,
} from './live/issues-list'

@Injectable()
export class SentryViewsService {
  private readonly logger = new Logger(SentryViewsService.name)

  constructor(private readonly oauthService: SentryOAuthService) {}

  /**
   * Errors-list view. Returns the org's unresolved issues over
   * `period`, sorted by `sort`. Single API call to Sentry — no
   * caching, no DB writes (the list freshness comes from Sentry, not
   * from our side).
   *
   * The view tile re-calls this on every render + on user filter
   * change; Sentry's rate limit is 40 req/s for the public API
   * which is comfortably above any plausible per-user load.
   */
  async fetchIssuesList(
    connectionId: string,
    userId: string,
    period: IssuesPeriod = '24h',
    sort: IssuesSort = 'recent',
  ): Promise<SentryIssue[]> {
    this.logger.log(
      `fetchIssuesList  connectionId=${connectionId}  period=${period}  sort=${sort}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const orgSlug = await this.oauthService.getOrgSlug(connectionId)

    return fetchIssuesList(token, connectionId, orgSlug, this.logger, period, sort)
  }
}
