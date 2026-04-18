import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { createHash } from 'crypto'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class CustomWebhookService {
  private readonly logger = new Logger(CustomWebhookService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async handleCustomWebhook(
    webhookId: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabaseService.getClient()

    // 1. Look up connection by webhook_id
    const { data: webhookRow, error: webhookError } = await client
      .from('connections_webhook')
      .select('connection_id')
      .eq('webhook_id', webhookId)
      .maybeSingle()

    if (webhookError || !webhookRow) {
      this.logger.warn(`  ⚠ No webhook connection found for webhookId: ${webhookId}`)
      throw new UnauthorizedException('Invalid webhook')
    }

    const connectionId = webhookRow.connection_id as string

    // 2. Verify API key
    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    const { data: keyRow } = await client
      .from('connections_webhook_keys')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle()

    if (!keyRow) {
      this.logger.warn(`  ⚠ Invalid or revoked API key for connection: ${connectionId}`)
      throw new UnauthorizedException('Invalid API key')
    }

    // 3. Get all views for this connection
    const { data: views } = await client
      .from('views')
      .select('id, type, config')
      .eq('connection_id', connectionId)

    if (!views || views.length === 0) {
      this.logger.log(`  → No views found for custom webhook connection: ${connectionId}`)
      return
    }

    this.logger.log(
      `\n  ► handleCustomWebhook\n  webhookId    : ${webhookId}\n  connectionId : ${connectionId}\n  views        : ${views.length}`,
    )

    for (const view of views as { id: string; type: string; config: Record<string, unknown> }[]) {
      if (view.type === 'webhook_counter') {
        await this.incrementDailyCounter(view.id, client)
      } else if (view.type === 'webhook_gauge') {
        const field = (view.config?.field as string) ?? 'value'
        const raw = body[field]
        if (raw == null) {
          this.logger.warn(
            `  ⚠ Field "${field}" not found in body — skipping gauge view ${view.id}`,
          )
          continue
        }
        await this.storeGaugeValue(view.id, String(raw), client)
      } else if (view.type === 'webhook_append') {
        const field = (view.config?.field as string) ?? 'value'
        const raw = body[field]
        if (raw == null) {
          this.logger.warn(
            `  ⚠ Field "${field}" not found in body — skipping append view ${view.id}`,
          )
          continue
        }
        await this.appendValue(view.id, String(raw), client)
      }
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

  private async storeGaugeValue(
    viewId: string,
    value: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0]

    const { data: existing } = await client
      .from('views_values')
      .select('id')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle()

    if (existing) {
      await client
        .from('views_values')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      this.logger.log(`  ✓ gauge updated → ${value}`)
    } else {
      await client.from('views_values').insert({ view_id: viewId, value, created_at: today })
      this.logger.log(`  ✓ gauge created → ${value}`)
    }
  }

  private async appendValue(
    viewId: string,
    value: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0]
    await client.from('views_values').insert({ view_id: viewId, value, created_at: today })
    this.logger.log(`  ✓ appended → ${value}`)
  }
}
