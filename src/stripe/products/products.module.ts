import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { StripeSyncModule } from '../sync/sync.module'
import { StripeRepositoriesModule } from '../stripe-repositories.module'
import { StripeProductsController } from './products.controller'
import { StripeProductsService } from './products.service'

@Module({
  imports: [StripeRepositoriesModule, ConnectionsRepositoriesModule, StripeSyncModule],
  controllers: [StripeProductsController],
  providers: [StripeProductsService],
  exports: [StripeProductsService],
})
export class StripeProductsModule {}
