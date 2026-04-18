import { Module } from '@nestjs/common'
import { GoogleAnalyticsConnectionModule } from './connection/connection.module'
import { GoogleAnalyticsViewsModule } from './views/views.module'

@Module({
  imports: [GoogleAnalyticsConnectionModule, GoogleAnalyticsViewsModule],
})
export class GoogleAnalyticsModule {}
