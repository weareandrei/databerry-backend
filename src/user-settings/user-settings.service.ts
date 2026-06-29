import { Injectable, Logger } from '@nestjs/common'
import { safeTzLiteral } from '../common/tz'
import { UserSettingsRepository } from './user-settings.repository'

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

  constructor(private readonly userSettingsRepository: UserSettingsRepository) {}

  async get(userId: string): Promise<UserSettings> {
    const { data, error } = await this.userSettingsRepository.findByUserId(userId)
    if (error) throw new Error(error.message)

    if (!data) {
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
      patch.timezone =
        dto.timezone === null ? null : safeTzLiteral(dto.timezone)
    }

    const { data, error } = await this.userSettingsRepository.upsert(patch)
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
