import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { StripeViewsController } from './views.controller'
import { StripeViewsService } from './views.service'
import { StripeRepositoriesModule } from '../stripe-repositories.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [StripeRepositoriesModule, ConnectionsRepositoriesModule, ViewsModule],
  controllers: [StripeViewsController],
  providers: [StripeViewsService],
  exports: [StripeViewsService],
})
export class StripeViewsModule {}
