import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CalendlyService } from './calendly.service';

@Controller('calendly')
export class CalendlyController {
  constructor(private readonly calendlyService: CalendlyService) {}

  @UseGuards(SupabaseAuthGuard)
  @Get('oauth/start')
  async oauthStart(@Req() req: { authUser: { id: string } }) {
    const url = await this.calendlyService.getOAuthUrl(req.authUser.id);
    return { url };
  }

  // No guard — this is called by Calendly's redirect (no Bearer token)
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: any,
  ) {
    const redirectUrl = await this.calendlyService.handleOAuthCallback(code, state);
    res.redirect(redirectUrl);
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('live-value')
  async getLiveValue(
    @Query('connectionId') connectionId: string,
    @Query('viewType') viewType: string,
    @Req() req: { authUser: { id: string } },
  ) {
    const value = await this.calendlyService.fetchLiveValue(connectionId, viewType, req.authUser.id);
    return { value };
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('meetings-list')
  async getMeetingsList(
    @Query('connectionId') connectionId: string,
    @Req() req: { authUser: { id: string } },
  ) {
    const meetings = await this.calendlyService.fetchMeetingsList(connectionId, req.authUser.id);
    return { meetings };
  }
}
