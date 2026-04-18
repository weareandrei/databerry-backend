import { Module } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from './oauth'
import { GoogleAnalyticsPropertiesService } from './properties'
import { GoogleAnalyticsConnectionController } from './connection.controller'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [GoogleAnalyticsOAuthService, GoogleAnalyticsPropertiesService],
  controllers: [GoogleAnalyticsConnectionController],
  exports: [GoogleAnalyticsOAuthService],
})
export class GoogleAnalyticsConnectionModule {}
