import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { SchedulerService } from './scheduler.service'
import { GoogleAnalyticsConnectionModule } from '../google-analytics/connection/connection.module'
import { CalendlyConnectionModule } from '../calendly/connection/connection.module'

@Module({
  // GA + Calendly connection modules export their OAuth services so the
  // proactive token-refresh cron in `scheduler.service.ts` can call
  // `ensureFreshToken(connectionId)` on rows close to expiring.
  imports: [SupabaseModule, GoogleAnalyticsConnectionModule, CalendlyConnectionModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
