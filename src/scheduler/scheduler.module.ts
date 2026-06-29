import { Module } from '@nestjs/common'
import { ViewsRepository } from '../views/views.repository'
import { PosthogConnectionModule } from '../posthog/connection/connection.module'
import { ConnectionsRepositoriesModule } from '../connections/connections-repositories.module'
import { StripeRepositoriesModule } from '../stripe/stripe-repositories.module'
import { SchedulerService } from './scheduler.service'

@Module({
  imports: [PosthogConnectionModule, ConnectionsRepositoriesModule, StripeRepositoriesModule],
  providers: [ViewsRepository, SchedulerService],
})
export class SchedulerModule {}
