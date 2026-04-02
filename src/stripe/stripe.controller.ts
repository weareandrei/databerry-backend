import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  /**
   * Protected — frontend calls this with auth header to get the OAuth URL.
   * Returns { url } so the frontend can redirect the browser there.
   */
  @Get('oauth/start')
  @UseGuards(SupabaseAuthGuard)
  startOAuth(@Req() req: any): { url: string } {
    const url = this.stripeService.getOAuthUrl(req.authUser.id);
    return { url };
  }

  /**
   * Public — Stripe redirects the browser here after the user authorises.
   * No auth guard: we read userId from the `state` query param.
   */
  @Get('oauth/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';

    if (oauthError) {
      return res.redirect(`${frontendUrl}/connections?stripe=error&reason=${oauthError}`);
    }

    try {
      await this.stripeService.handleOAuthCallback(code, state);
      return res.redirect(`${frontendUrl}/connections?stripe=connected`);
    } catch {
      return res.redirect(`${frontendUrl}/connections?stripe=error`);
    }
  }
}
