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
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stripeViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }

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
    const points = await this.stripeViewsService.fetchChartData(
      connectionId,
      viewType,
      req.authUser.id,
      dateFrom,
      dateTo,
      mode,
      tz,
    )
    return { points }
  }

  /**
   * Top customers list — separate route from `live-value` because the wire
   * shape is an array of structured rows, not a single string. Mirrors
   * `GET /calendly/views/meetings`. Date range optional (defaults to "today").
   */
  @Get('top-customers')
  async getTopCustomers(
    @Query('connectionId') connectionId: string,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stripeViewsService.fetchTopCustomers(
      connectionId,
      req.authUser.id,
      dateFrom,
      dateTo,
      tz,
    )
  }
}
