import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { CalendlyOAuthService } from './oauth'
import type { AuthenticatedRequest } from '../../common/types'

@Controller('calendly')
export class CalendlyConnectionController {
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
    @Res() res: any,
  ) {
    const redirectUrl = await this.calendlyOAuthService.handleOAuthCallback(code, state)
    res.redirect(redirectUrl)
  }
}
