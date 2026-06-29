import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { createHash } from 'crypto'
import { ViewsRepository } from '../views/views.repository'
import { WebhooksRepository } from './webhooks.repository'

@Injectable()
export class CustomWebhookService {
  private readonly logger = new Logger(CustomWebhookService.name)

  constructor(
    private readonly webhooksRepository: WebhooksRepository,
    private readonly viewsRepository: ViewsRepository,
  ) {}

  async handleCustomWebhook(
    webhookId: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const { data: webhookRow, error: webhookError } =
      await this.webhooksRepository.findByWebhookId(webhookId)

    if (webhookError || !webhookRow) {
      this.logger.warn(`  ⚠ No webhook connection found for webhookId: ${webhookId}`)
      throw new UnauthorizedException('Invalid webhook')
    }

    const connectionId = webhookRow.connection_id as string

    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    const { data: keyRow } = await this.webhooksRepository.findValidKey(
      connectionId,
      keyHash,
    )

    if (!keyRow) {
      this.logger.warn(`  ⚠ Invalid or revoked API key for connection: ${connectionId}`)
      throw new UnauthorizedException('Invalid API key')
    }

    const { data: views } = await this.viewsRepository.findByConnectionId(connectionId)

    if (!views || views.length === 0) {
      this.logger.log(`  → No views found for custom webhook connection: ${connectionId}`)
      return
    }

    this.logger.log(
      `\n  ► handleCustomWebhook\n  webhookId    : ${webhookId}\n  connectionId : ${connectionId}\n  views        : ${views.length}`,
    )

    const today = new Date().toISOString().split('T')[0]

    for (const view of views as { id: string; type: string; config: Record<string, unknown> }[]) {
      if (view.type === 'webhook_counter' || view.type === 'webhook_append') {
        await this.incrementDailyCounter(view.id, today)
      } else if (view.type === 'webhook_gauge') {
        const field = (view.config?.field as string) ?? 'value'
        const raw = body[field]
        if (raw == null) {
          this.logger.warn(
            `  ⚠ Field "${field}" not found in body — skipping gauge view ${view.id}`,
          )
          continue
        }
        await this.storeGaugeValue(view.id, String(raw), today)
      }
    }
  }

  private async incrementDailyCounter(viewId: string, today: string): Promise<void> {
    const { error: insertError } = await this.viewsRepository.insertValue({
      view_id: viewId,
      value: '1',
      created_at: today,
      needs_sync: false,
    })

    if (insertError?.code === '23505') {
      const { data: existing } = await this.viewsRepository.findValueByViewAndDate(viewId, today)

      if (existing) {
        const newValue = (parseInt(existing.value as string, 10) || 0) + 1
        await this.viewsRepository.updateValueById(existing.id as string, {
          value: String(newValue),
          updated_at: new Date().toISOString(),
        })
        this.logger.log(`  ✓ daily counter incremented → ${newValue}`)
      }
    } else if (insertError) {
      this.logger.error(`  ✗ Failed to create daily counter\n  ${insertError.message}`)
    } else {
      this.logger.log(`  ✓ daily counter created → 1`)
    }
  }

  private async storeGaugeValue(viewId: string, value: string, today: string): Promise<void> {
    const { error: insertError } = await this.viewsRepository.insertValue({
      view_id: viewId,
      value,
      created_at: today,
      needs_sync: false,
    })

    if (insertError?.code === '23505') {
      await this.viewsRepository.updateGaugeValue(viewId, today, value)
      this.logger.log(`  ✓ gauge updated → ${value}`)
    } else if (insertError) {
      this.logger.error(`  ✗ Failed to store gauge value\n  ${insertError.message}`)
    } else {
      this.logger.log(`  ✓ gauge created → ${value}`)
    }
  }
}
