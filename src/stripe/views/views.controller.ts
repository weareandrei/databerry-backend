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
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.stripeViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
    )
    return { value }
  }

  @Get('chart-data')
  async getChartData(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const points = await this.stripeViewsService.fetchChartData(
      connectionId,
      viewType,
      req.authUser.id,
    )
    return { points }
  }
}
