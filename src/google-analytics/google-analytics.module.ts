import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { ViewsModule } from '../views/views.module'
import { GoogleAnalyticsService } from './google-analytics.service'
import { GoogleAnalyticsController } from './google-analytics.controller'

@Module({
  imports: [SupabaseModule, ViewsModule],
  providers: [GoogleAnalyticsService],
  controllers: [GoogleAnalyticsController],
})
export class GoogleAnalyticsModule {}
