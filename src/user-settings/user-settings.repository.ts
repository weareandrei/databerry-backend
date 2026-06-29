import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class UserSettingsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
  }

  async upsert(patch: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('user_settings')
      .upsert(patch, { onConflict: 'user_id' })
      .select()
      .single()
  }
}
