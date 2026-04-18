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
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.gaViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
    )
    return { value }
  }
}
