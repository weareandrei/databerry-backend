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
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.posthogViewsService.fetchLiveValue(connectionId, viewId, req.authUser.id)
    return { value }
  }
}
