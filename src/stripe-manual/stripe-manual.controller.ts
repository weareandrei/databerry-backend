import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { StripeManualService } from './stripe-manual.service'
import type { AuthenticatedRequest } from '../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('stripe-manual')
export class StripeManualController {
  constructor(private readonly stripeManualService: StripeManualService) {}

  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.stripeManualService.fetchLiveValue(
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
    const points = await this.stripeManualService.fetchChartData(
      connectionId,
      viewType,
      req.authUser.id,
    )
    return { points }
  }
}
