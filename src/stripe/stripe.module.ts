import { Module } from '@nestjs/common'
import { StripeConnectionModule } from './connection/connection.module'
import { StripeWebhookModule } from './webhook/webhook.module'
import { StripeViewsModule } from './views/views.module'

@Module({
  imports: [StripeConnectionModule, StripeWebhookModule, StripeViewsModule],
})
export class StripeModule {}
