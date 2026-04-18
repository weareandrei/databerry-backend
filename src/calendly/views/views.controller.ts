import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { CalendlyViewsService } from './views.service'
import type { AuthenticatedRequest } from '../../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('calendly/views')
export class CalendlyViewsController {
  constructor(private readonly calendlyViewsService: CalendlyViewsService) {}

  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.calendlyViewsService.fetchLiveValue(
      connectionId,
      viewType,
      req.authUser.id,
    )
    return { value }
  }

  @Get('meetings-list')
  async getMeetingsList(
    @Query('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const meetings = await this.calendlyViewsService.fetchMeetingsList(
      connectionId,
      req.authUser.id,
    )
    return { meetings }
  }
}
