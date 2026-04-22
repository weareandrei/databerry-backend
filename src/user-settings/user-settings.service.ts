import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export interface UpdateUserSettingsDto {
  preferredTrafficConnectionId?: string | null
  conversionConnectionId?: string | null
  conversionEvent?: string | null
}

export interface UserSettings {
  userId: string
  preferredTrafficConnectionId: string | null
  conversionConnectionId: string | null
  conversionEvent: string | null
}

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async get(userId: string): Promise<UserSettings> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw new Error(error.message)

    if (!data) {
      // Return a defaults object without persisting — first write creates the row.
      return {
        userId,
        preferredTrafficConnectionId: null,
        conversionConnectionId: null,
        conversionEvent: null,
      }
    }

    return this.toCamel(data)
  }

  async update(userId: string, dto: UpdateUserSettingsDto): Promise<UserSettings> {
    const patch: Record<string, unknown> = {
      user_id: userId,
      updated_at: new Date().toISOString(),
    }
    if (dto.preferredTrafficConnectionId !== undefined)
      patch.preferred_traffic_connection_id = dto.preferredTrafficConnectionId
    if (dto.conversionConnectionId !== undefined)
      patch.conversion_connection_id = dto.conversionConnectionId
    if (dto.conversionEvent !== undefined) patch.conversion_event = dto.conversionEvent

    const { data, error } = await this.supabaseService
      .getClient()
      .from('user_settings')
      .upsert(patch, { onConflict: 'user_id' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    this.logger.log(`  ✓ user_settings upserted for ${userId}`)
    return this.toCamel(data)
  }

  private toCamel(row: Record<string, unknown>): UserSettings {
    return {
      userId: row.user_id as string,
      preferredTrafficConnectionId: (row.preferred_traffic_connection_id as string | null) ?? null,
      conversionConnectionId: (row.conversion_connection_id as string | null) ?? null,
      conversionEvent: (row.conversion_event as string | null) ?? null,
    }
  }
}
