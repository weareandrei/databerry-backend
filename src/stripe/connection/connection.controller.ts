import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { StripeOAuthService } from './oauth'

@Controller('stripe')
export class StripeConnectionController {
  constructor(private readonly stripeOAuthService: StripeOAuthService) {}

  /** Protected — frontend calls this to get the Stripe Connect OAuth URL. */
  @Get('oauth/start')
  @UseGuards(SupabaseAuthGuard)
  startOAuth(@Req() req: any): { url: string } {
    return { url: this.stripeOAuthService.getOAuthUrl(req.authUser.id) }
  }

  /** Public — Stripe redirects here after the user authorises. */
  @Get('oauth/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'

    if (oauthError) {
      return res.redirect(`${frontendUrl}/connections?stripe=error&reason=${oauthError}`)
    }

    try {
      await this.stripeOAuthService.handleOAuthCallback(code, state)
      return res.redirect(`${frontendUrl}/connections?stripe=connected`)
    } catch {
      return res.redirect(`${frontendUrl}/connections?stripe=error`)
    }
  }
}
