import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { GoogleAnalyticsViewsService } from './views.service'
import type { AuthenticatedRequest } from '../../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('google-analytics/views')
export class GoogleAnalyticsViewsController {
  constructor(private readonly gaViewsService: GoogleAnalyticsViewsService) {}

  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gaViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }

  /**
   * Time-series for `ga_users_today` / `ga_sessions_today` /
   * `ga_pageviews_today` views in chart mode (`config.displayMode === 'chart'`).
   * Mirrors `/stripe/views/chart-data` shape — `{ points: ChartPoint[] }`.
   */
  @Get('chart-data')
  async getChartData(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('mode') mode: 'daily' | 'weekly' | 'monthly' | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gaViewsService.fetchChartData(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
      mode,
      tz,
    )
  }
}
