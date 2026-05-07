import { Controller, Get, Logger, Query, Req, Res, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { CalendlyOAuthService } from './oauth'
import { getPrimaryFrontendUrl } from '../../common/frontend-url'
import type { AuthenticatedRequest } from '../../common/types'

@Controller('calendly')
export class CalendlyConnectionController {
  private readonly logger = new Logger(CalendlyConnectionController.name)

  constructor(private readonly calendlyOAuthService: CalendlyOAuthService) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(@Req() req: AuthenticatedRequest) {
    const url = await this.calendlyOAuthService.getOAuthUrl(req.authUser.id)
    return { url }
  }

  // No guard — called by Calendly's redirect (no Bearer token)
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError: string | undefined,
    @Res() res: any,
  ) {
    // Calendly sets `?error=access_denied` when the user clicks
    // "Cancel" on the consent screen. Distinguish that from server-
    // side failures so the frontend can show "you cancelled" rather
    // than "something broke".
    if (oauthError) {
      const frontendUrl = getPrimaryFrontendUrl()
      const reason = oauthError === 'access_denied' ? 'cancelled' : 'token_exchange'
      this.logger.warn(`Calendly OAuth callback received error=${oauthError}`)
      return res.redirect(
        `${frontendUrl}/hub/connections?calendly=error&reason=${reason}`,
      )
    }
    const redirectUrl = await this.calendlyOAuthService.handleOAuthCallback(code, state)
    res.redirect(redirectUrl)
  }
}
