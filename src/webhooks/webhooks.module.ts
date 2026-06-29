import { Module } from '@nestjs/common'
import { WebhooksController } from './webhooks.controller'
import { CustomWebhookService } from './custom-webhook.service'
import { WebhooksRepository } from './webhooks.repository'
import { ViewsRepository } from '../views/views.repository'
import { StripeWebhookModule } from '../stripe/webhook/webhook.module'
import { PosthogWebhookModule } from '../posthog/webhook/webhook.module'

@Module({
  imports: [StripeWebhookModule, PosthogWebhookModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksRepository,
    ViewsRepository,
    CustomWebhookService,
  ],
})
export class WebhooksModule {}
