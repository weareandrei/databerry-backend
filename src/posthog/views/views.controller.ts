import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { PosthogViewsService } from './views.service'
import type { AuthenticatedRequest } from '../../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('posthog/views')
export class PosthogViewsController {
  constructor(private readonly posthogViewsService: PosthogViewsService) {}

  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewId') viewId: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.posthogViewsService.fetchLiveValue(
      connectionId,
      viewId,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }

  /**
   * Funnel — `{ steps: FunnelStepRow[] }`. One route per non-`live-value`
   * view type, mirroring the convention established by Stripe's
   * `/stripe/views/top-customers`. Keeps the wire shape per route specific
   * and avoids the "discriminated union over `value`" ergonomic mess.
   */
  @Get('funnel')
  async getFunnel(
    @Query('connectionId') connectionId: string,
    @Query('viewId') viewId: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.posthogViewsService.fetchFunnel(
      connectionId,
      viewId,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }

  /**
   * Retention heatmap — `{ cohorts, periodLabel }`. The query ignores
   * `dateFrom` (cohort window is derived from `dateTo` and the view's
   * `cohortCount` config); we still accept it to keep the call signature
   * uniform with the rest of the routes.
   */
  @Get('retention')
  async getRetention(
    @Query('connectionId') connectionId: string,
    @Query('viewId') viewId: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.posthogViewsService.fetchRetention(
      connectionId,
      viewId,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }

  /**
   * Recent-users list — `{ users: PosthogUserRow[] }`. Up to 500 users in
   * the date range, ordered by recency. No view config required.
   */
  @Get('users')
  async getUsers(
    @Query('connectionId') connectionId: string,
    @Query('viewId') viewId: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.posthogViewsService.fetchUsers(
      connectionId,
      viewId,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }
}
