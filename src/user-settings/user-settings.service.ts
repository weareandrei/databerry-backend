import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { safeTzLiteral } from '../common/tz'

export interface UpdateUserSettingsDto {
  preferredTrafficConnectionId?: string | null
  /**
   * IANA timezone (e.g. `Europe/Bucharest`, `America/Los_Angeles`). Sanitized
   * server-side via `safeTzLiteral` — anything that doesn't match the IANA
   * shape is normalised to `'UTC'` so we can never persist injection bait.
   * `null` (explicitly) clears the user's choice and lets the frontend
   * auto-detect on the next load.
   */
  timezone?: string | null
}

export interface UserSettings {
  userId: string
  preferredTrafficConnectionId: string | null
  /**
   * `null` means "not set yet" — the frontend's `UserSettingsProvider`
   * auto-detects via `Intl.DateTimeFormat()...` and writes back. Backend
   * code that needs a tz should fall back to `'UTC'` rather than throwing.
   */
  timezone: string | null
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
        timezone: null,
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
    if (dto.timezone !== undefined) {
      // Sanitize at the boundary. `null` is allowed (clears the field);
      // anything else gets the safeTzLiteral pass — bogus input collapses
      // to 'UTC' rather than persisting unsafe data.
      patch.timezone =
        dto.timezone === null ? null : safeTzLiteral(dto.timezone)
    }

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
      timezone: (row.timezone as string | null) ?? null,
    }
  }
}
