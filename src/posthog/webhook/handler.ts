import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

@Injectable()
export class PosthogWebhookService {
  private readonly logger = new Logger(PosthogWebhookService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async handlePosthogEvent(
    connectionId: string,
    viewId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventName = payload.event as string | undefined

    this.logger.log(
      `\n  ► handlePosthogEvent\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  event        : ${eventName ?? '(none)'}`,
    )

    const client = this.supabaseService.getClient()

    const { data: view, error: viewError } = await client
      .from('views')
      .select('type')
      .eq('id', viewId)
      .single()

    if (viewError || !view) {
      this.logger.warn(`  ⚠ View not found — skipping\n  viewId : ${viewId}`)
      return
    }

    const viewType = (view.type as string) ?? 'daily_counter'
    this.logger.log(`  → view type : ${viewType}`)

    if (viewType === 'daily_counter') {
      await this.incrementDailyCounter(viewId, client)
    } else {
      this.logger.warn(`  ⚠ Unknown view type "${viewType}" — skipping`)
    }
  }

  private async incrementDailyCounter(
    viewId: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0]

    const { data: existing } = await client
      .from('views_values')
      .select('id, value')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle()

    if (existing) {
      const newValue = (parseInt(existing.value as string, 10) || 0) + 1
      const { error } = await client
        .from('views_values')
        .update({ value: String(newValue), updated_at: new Date().toISOString() })
        .eq('id', existing.id)

      if (error) {
        this.logger.error(`  ✗ Failed to update daily counter\n  ${error.message}`)
        return
      }
      this.logger.log(`  ✓ daily counter updated → ${newValue}`)
    } else {
      const { error } = await client
        .from('views_values')
        .insert({ view_id: viewId, value: '1', created_at: today })

      if (error) {
        this.logger.error(`  ✗ Failed to create daily counter\n  ${error.message}`)
        return
      }
      this.logger.log(`  ✓ daily counter created → 1`)
    }
  }
}
