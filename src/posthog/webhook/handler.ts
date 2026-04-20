import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { markNeedsSync } from '../../views/views-sync.helper'

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
    const today = new Date().toISOString().split('T')[0]

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
      await markNeedsSync(viewId, today, client)
      this.logger.log(`  ✓ marked needs_sync for viewId=${viewId} date=${today}`)
    } else {
      this.logger.warn(`  ⚠ Unknown view type "${viewType}" — skipping`)
    }
  }
}
