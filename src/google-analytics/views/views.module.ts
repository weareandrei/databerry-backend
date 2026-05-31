import { Module } from '@nestjs/common'
import { GoogleAnalyticsViewsController } from './views.controller'
import { GoogleAnalyticsViewsService } from './views.service'
import { GoogleAnalyticsConnectionModule } from '../connection/connection.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [GoogleAnalyticsConnectionModule, ViewsModule],
  controllers: [GoogleAnalyticsViewsController],
  providers: [GoogleAnalyticsViewsService],
  // Exported so `ChatModule` can call `fetchLiveValue` in-process for
  // the chat agent's `get_ga_metric` tool. Same per-user scoping
  // (`verifyOwnership` inside the service) as the controller.
  exports: [GoogleAnalyticsViewsService],
})
export class GoogleAnalyticsViewsModule {}
