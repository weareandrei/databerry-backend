import { Module } from '@nestjs/common'
import { StripeConnectionModule } from './connection/connection.module'
import { StripeWebhookModule } from './webhook/webhook.module'
import { StripeViewsModule } from './views/views.module'
import { StripeSyncModule } from './sync/sync.module'
import { StripeProductsModule } from './products/products.module'
import { StripeRepositoriesModule } from './stripe-repositories.module'

@Module({
  imports: [
    StripeRepositoriesModule,
    StripeConnectionModule,
    StripeWebhookModule,
    StripeViewsModule,
    StripeSyncModule,
    StripeProductsModule,
  ],
  exports: [
    StripeRepositoriesModule,
    StripeConnectionModule,
    StripeWebhookModule,
    StripeViewsModule,
    StripeSyncModule,
    StripeProductsModule,
  ],
})
export class StripeModule {}
