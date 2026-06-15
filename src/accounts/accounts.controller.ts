import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { AccountsService } from './accounts.service'

@Controller('accounts')
@UseGuards(SupabaseAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get('me')
  getMe(@Req() req: any) {
    return this.accountsService.getOrCreateAccount(req.authUser.id)
  }

  /**
   * Mark the user's onboarding as complete. Fired by /onboarding on
   * BOTH "Finish" and "Skip" — either way we never show the flow
   * again; the skip/finish distinction lives in PostHog events, not
   * DB state. Idempotent; returns the updated account row so the
   * client can refresh its local copy without a second GET.
   */
  @Post('me/onboarding-complete')
  completeOnboarding(@Req() req: any) {
    return this.accountsService.markOnboardingComplete(req.authUser.id)
  }

  /**
   * Stamp `trial_started_at` / `trial_ends_at` (now / now + 7 days).
   * Fired by the dashboard's `<TrialKickoff>` on the user's FIRST
   * post-onboarding hub visit — the trial clock deliberately does
   * not start at signup. Idempotent + race-safe (see service); paid
   * `plan_id`s are exempt. Returns the (possibly unchanged) account.
   */
  @Post('me/start-trial')
  startTrial(@Req() req: any) {
    return this.accountsService.startTrial(req.authUser.id)
  }
}
