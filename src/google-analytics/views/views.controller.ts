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
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gaViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
    )
  }
}
