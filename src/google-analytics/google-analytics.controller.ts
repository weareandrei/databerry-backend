import { Body, Controller, Get, Patch, Query, Req, Res, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { GoogleAnalyticsService } from './google-analytics.service'
import type { AuthenticatedRequest } from '../common/types'

@Controller('google-analytics')
export class GoogleAnalyticsController {
  constructor(private readonly gaService: GoogleAnalyticsService) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(@Req() req: AuthenticatedRequest) {
    const url = await this.gaService.getOAuthUrl(req.authUser.id)
    return { url }
  }

  // No auth guard — called by Google's redirect (no Bearer token)
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: any,
  ) {
    const redirectUrl = await this.gaService.handleOAuthCallback(code, state)
    res.redirect(redirectUrl)
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('properties')
  async getProperties(
    @Query('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const properties = await this.gaService.getProperties(connectionId, req.authUser.id)
    return { properties }
  }

  @UseGuards(SupabaseAuthGuard)
  @Patch('property')
  async saveProperty(
    @Query('connectionId') connectionId: string,
    @Body() body: { propertyId: string },
    @Req() req: AuthenticatedRequest,
  ) {
    await this.gaService.saveProperty(connectionId, body.propertyId, req.authUser.id)
    return { ok: true }
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const value = await this.gaService.fetchLiveValue(connectionId, viewType, req.authUser.id)
    return { value }
  }
}
