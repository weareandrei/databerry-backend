import { Body, Controller, Get, Patch, Query, Req, Res, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { GoogleAnalyticsService } from './google-analytics.service'
import type { AuthenticatedRequest } from '../common/types'
import type { Request } from 'express'

/** Derive the backend's own public base URL from request headers.
 *  Works on any host: local dev, Railway, Render, etc. */
function backendBaseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)
    ?? (req.hostname === 'localhost' ? 'http' : 'https')
  const host = (req.headers['x-forwarded-host'] as string | undefined)
    ?? req.headers['host']
    ?? 'localhost:3001'
  return `${proto}://${host}`
}

@Controller('google-analytics')
export class GoogleAnalyticsController {
  constructor(private readonly gaService: GoogleAnalyticsService) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(@Req() req: AuthenticatedRequest & Request) {
    const redirectUri = `${backendBaseUrl(req)}/google-analytics/oauth/callback`
    const url = await this.gaService.getOAuthUrl(req.authUser.id, redirectUri)
    return { url }
  }

  // No auth guard — called by Google's redirect (no Bearer token)
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: any,
  ) {
    const redirectUri = `${backendBaseUrl(req)}/google-analytics/oauth/callback`
    const redirectUrl = await this.gaService.handleOAuthCallback(code, state, redirectUri)
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
