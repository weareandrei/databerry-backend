import { Controller, Get, Logger, Query, Req, Res, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { SentryOAuthService } from './oauth'
import { getPrimaryFrontendUrl } from '../../common/frontend-url'
import type { AuthenticatedRequest } from '../../common/types'

@Controller('sentry')
export class SentryConnectionController {
  private readonly logger = new Logger(SentryConnectionController.name)

  constructor(private readonly sentryOAuthService: SentryOAuthService) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(
    @Query('name') name: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const url = await this.sentryOAuthService.getOAuthUrl(req.authUser.id, name)
    return { url }
  }

  // No guard — called by Sentry's redirect (no Bearer token from us).
  // Sentry's install redirect carries `installationId` alongside the
  // usual `code` + `state`. The user can also click "Cancel" on the
  // install screen, in which case Sentry redirects with `?error=...`.
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('installationId') installationId: string,
    @Query('error') oauthError: string | undefined,
    @Res() res: any,
  ) {
    if (oauthError) {
      const frontendUrl = getPrimaryFrontendUrl()
      const reason = oauthError === 'access_denied' ? 'cancelled' : 'token_exchange'
      this.logger.warn(`Sentry OAuth callback received error=${oauthError}`)
      return res.redirect(
        `${frontendUrl}/hub/connections?sentry=error&reason=${reason}`,
      )
    }
    const redirectUrl = await this.sentryOAuthService.handleOAuthCallback(
      code,
      state,
      installationId,
    )
    res.redirect(redirectUrl)
  }
}
