import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export interface Account {
  id: string
  userId: string
  planId: string
  createdAt: string
  updatedAt: string
}

@Injectable()
export class AccountsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async getOrCreateAccount(userId: string): Promise<Account> {
    const client = this.supabaseService.getClient()

    // Upsert — safe to call on every request, trigger handles signup but this
    // acts as a fallback for users who existed before the trigger was added.
    const { data, error } = await client
      .from('accounts')
      .upsert({ user_id: userId }, { onConflict: 'user_id' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return this.toCamel(data)
  }

  private toCamel(row: Record<string, unknown>): Account {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      planId: row.plan_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
