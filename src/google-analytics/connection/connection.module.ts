import { Module } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from './oauth'
import { GoogleAnalyticsPropertiesService } from './properties'
import { GoogleAnalyticsConnectionController } from './connection.controller'
import { GoogleAnalyticsRepository } from './google-analytics.repository'
import { ConnectionsModule } from '../../connections/connections.module'

@Module({
  imports: [ConnectionsModule],
  providers: [
    GoogleAnalyticsRepository,
    GoogleAnalyticsOAuthService,
    GoogleAnalyticsPropertiesService,
  ],
  controllers: [GoogleAnalyticsConnectionController],
  exports: [GoogleAnalyticsOAuthService],
})
export class GoogleAnalyticsConnectionModule {}
