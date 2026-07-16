import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

/**
 * Landing-page social-proof counter ("N founders joined this month").
 *
 * On each public GET we:
 *   1. Read the singleton row (`count`, `updated_at`)
 *   2. For every full hour since `updated_at`, roll a 10% chance of +1
 *      (~2–3 joins/day on average)
 *   3. Persist the new count + `updated_at = now()`
 *   4. Return `{ count }`
 *
 * Monthly resets are intentional manual ops — not handled here.
 */
@Injectable()
export class FoundersJoinedService {
  private readonly logger = new Logger(FoundersJoinedService.name)

  constructor(private readonly supabase: SupabaseService) {}

  async getAndTick(): Promise<{ count: number }> {
    const client = this.supabase.getClient()

    const { data, error } = await client
      .from('founders_joined_month')
      .select('count, updated_at')
      .eq('id', 1)
      .maybeSingle()

    if (error) {
      this.logger.error(`Failed to read founders_joined_month: ${error.message}`)
      throw error
    }

    if (!data) {
      this.logger.error('founders_joined_month singleton row missing')
      throw new Error('founders_joined_month row missing — run the SQL migration')
    }

    const currentCount = typeof data.count === 'number' ? data.count : 0
    const updatedAt = new Date(data.updated_at as string)
    const hoursElapsed = Math.max(
      0,
      Math.floor((Date.now() - updatedAt.getTime()) / (60 * 60 * 1000)),
    )
    const joined = estimateJoinsSince(hoursElapsed)
    const nextCount = currentCount + joined

    // Always bump `updated_at` so we don't re-roll the same hours on
    // the next request — even when `joined === 0`.
    const { error: updateError } = await client
      .from('founders_joined_month')
      .update({ count: nextCount, updated_at: new Date().toISOString() })
      .eq('id', 1)

    if (updateError) {
      this.logger.error(`Failed to update founders_joined_month: ${updateError.message}`)
      throw updateError
    }

    if (joined > 0) {
      this.logger.log(
        `founders_joined_month: +${joined} over ${hoursElapsed}h → ${nextCount}`,
      )
    }

    return { count: nextCount }
  }
}

/**
 * Independent 10% chance of one signup per full elapsed hour.
 * 24h × 0.1 ≈ 2.4 expected joins/day.
 */
export function estimateJoinsSince(fullHoursElapsed: number): number {
  const hours = Math.max(0, Math.floor(fullHoursElapsed))
  let joins = 0
  for (let i = 0; i < hours; i++) {
    if (Math.random() < 0.1) joins += 1
  }
  return joins
}
