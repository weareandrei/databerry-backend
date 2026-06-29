import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { StripeWebhookService } from './handler'
import { StripeRepositoriesModule } from '../stripe-repositories.module'

@Module({
  imports: [StripeRepositoriesModule, ConnectionsRepositoriesModule],
  providers: [StripeWebhookService],
  exports: [StripeWebhookService],
})
export class StripeWebhookModule {}
