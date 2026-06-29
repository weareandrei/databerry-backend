import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class AccountsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async upsertByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .upsert({ user_id: userId }, { onConflict: 'user_id' })
      .select()
      .single()
  }

  async markOnboardingComplete(userId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .update({ onboarding_complete: true })
      .eq('user_id', userId)
      .select()
      .single()
  }

  async startTrialIfUnset(
    userId: string,
    trialStartedAt: string,
    trialEndsAt: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .update({
        trial_started_at: trialStartedAt,
        trial_ends_at: trialEndsAt,
      })
      .eq('user_id', userId)
      .is('trial_started_at', null)
      .select()
  }
}
