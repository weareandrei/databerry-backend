import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { ConnectionsModule } from '../connections/connections.module'
import { UserSettingsModule } from '../user-settings/user-settings.module'
import { ProjectSettingsModule } from '../project-settings/project-settings.module'
import { GoogleAnalyticsModule } from '../google-analytics/google-analytics.module'
import { GoogleAnalyticsConnectionModule } from '../google-analytics/connection/connection.module'
import { PosthogModule } from '../posthog/posthog.module'
import { StripeModule } from '../stripe/stripe.module'
import { ProjectOverviewController } from './project-overview.controller'
import { ProjectOverviewService } from './project-overview.service'

@Module({
  imports: [
    SupabaseModule,
    ConnectionsModule,
    UserSettingsModule,
    ProjectSettingsModule,
    GoogleAnalyticsModule,
    GoogleAnalyticsConnectionModule,
    PosthogModule,
    StripeModule,
  ],
  controllers: [ProjectOverviewController],
  providers: [ProjectOverviewService],
})
export class ProjectOverviewModule {}
