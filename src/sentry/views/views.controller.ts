import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { SentryViewsService } from './views.service'
import type { IssuesPeriod, IssuesSort } from './live/issues-list'
import type { AuthenticatedRequest } from '../../common/types'

const ALLOWED_PERIODS: IssuesPeriod[] = ['24h', '7d', '30d', '90d']
const ALLOWED_SORTS: IssuesSort[] = ['recent', 'frequent']

@UseGuards(SupabaseAuthGuard)
@Controller('sentry/views')
export class SentryViewsController {
  constructor(private readonly sentryViewsService: SentryViewsService) {}

  /**
   * Errors-list view. Wire shape: `{ issues: SentryIssue[] }`.
   *
   * `period` accepts `24h` / `7d` / `30d` / `90d` — anything else
   * coerces to the `24h` default. Same with `sort` (`recent` |
   * `frequent`). Defaults make the most-common "what's broken now"
   * read a zero-config call from the frontend.
   */
  @Get('issues-list')
  async getIssuesList(
    @Query('connectionId') connectionId: string,
    @Query('period') period: string | undefined,
    @Query('sort') sort: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const safePeriod: IssuesPeriod = ALLOWED_PERIODS.includes(period as IssuesPeriod)
      ? (period as IssuesPeriod)
      : '24h'
    const safeSort: IssuesSort = ALLOWED_SORTS.includes(sort as IssuesSort)
      ? (sort as IssuesSort)
      : 'recent'

    const issues = await this.sentryViewsService.fetchIssuesList(
      connectionId,
      req.authUser.id,
      safePeriod,
      safeSort,
    )
    return { issues }
  }
}
