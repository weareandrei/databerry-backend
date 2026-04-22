import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { StripeViewsService } from './views.service'
import type { AuthenticatedRequest } from '../../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('stripe/views')
export class StripeViewsController {
  constructor(private readonly stripeViewsService: StripeViewsService) {}

  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stripeViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
    )
  }

  @Get('chart-data')
  async getChartData(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('mode') mode: 'daily' | 'weekly' | 'monthly' | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const points = await this.stripeViewsService.fetchChartData(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
      mode,
    )
    return { points }
  }
}
