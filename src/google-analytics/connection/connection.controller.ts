import {
  Body,
  Controller,
  Get,
  Logger,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { GoogleAnalyticsOAuthService } from './oauth'
import { GoogleAnalyticsPropertiesService } from './properties'
import { getPrimaryFrontendUrl } from '../../common/frontend-url'
import type { AuthenticatedRequest } from '../../common/types'

/** Derive the backend's own public base URL from request headers. */
function backendBaseUrl(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    (req.hostname === 'localhost' ? 'http' : 'https')
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    req.headers['host'] ??
    'localhost:3001'
  return `${proto}://${host}`
}

@Controller('google-analytics')
export class GoogleAnalyticsConnectionController {
  private readonly logger = new Logger(GoogleAnalyticsConnectionController.name)

  constructor(
    private readonly oauthService: GoogleAnalyticsOAuthService,
    private readonly propertiesService: GoogleAnalyticsPropertiesService,
  ) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(@Req() req: AuthenticatedRequest & Request) {
    const redirectUri = `${backendBaseUrl(req)}/google-analytics/oauth/callback`
    const url = await this.oauthService.getOAuthUrl(req.authUser.id, redirectUri)
    return { url }
  }

  // No auth guard — called by Google's redirect (no Bearer token)
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError: string | undefined,
    @Req() req: Request,
    @Res() res: any,
  ) {
    // Google sends `?error=access_denied` when the user clicks
    // "Cancel" on the consent screen. Distinguish that from server-
    // side failures so the frontend can show the right message.
    if (oauthError) {
      const frontendUrl = getPrimaryFrontendUrl()
      const reason = oauthError === 'access_denied' ? 'cancelled' : 'token_exchange'
      this.logger.warn(`GA OAuth callback received error=${oauthError}`)
      return res.redirect(
        `${frontendUrl}/hub/connections?google_analytics=error&reason=${reason}`,
      )
    }
    const redirectUri = `${backendBaseUrl(req)}/google-analytics/oauth/callback`
    const redirectUrl = await this.oauthService.handleOAuthCallback(code, state, redirectUri)
    res.redirect(redirectUrl)
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('properties')
  async getProperties(
    @Query('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const properties = await this.propertiesService.getProperties(connectionId, req.authUser.id)
    return { properties }
  }

  @UseGuards(SupabaseAuthGuard)
  @Patch('property')
  async saveProperty(
    @Query('connectionId') connectionId: string,
    @Body() body: { propertyId: string },
    @Req() req: AuthenticatedRequest,
  ) {
    await this.propertiesService.saveProperty(connectionId, body.propertyId, req.authUser.id)
    return { ok: true }
  }
}
