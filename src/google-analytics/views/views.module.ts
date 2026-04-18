import { Module } from '@nestjs/common'
import { GoogleAnalyticsViewsController } from './views.controller'
import { GoogleAnalyticsViewsService } from './views.service'
import { GoogleAnalyticsConnectionModule } from '../connection/connection.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [GoogleAnalyticsConnectionModule, ViewsModule],
  controllers: [GoogleAnalyticsViewsController],
  providers: [GoogleAnalyticsViewsService],
})
export class GoogleAnalyticsViewsModule {}
