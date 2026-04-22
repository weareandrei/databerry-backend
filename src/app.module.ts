import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { SupabaseModule } from './supabase/supabase.module'
import { ProjectsModule } from './projects/projects.module'
import { FoldersModule } from './folders/folders.module'
import { ConnectionsModule } from './connections/connections.module'
import { AccountsModule } from './accounts/accounts.module'
import { ViewsModule } from './views/views.module'
import { WebhooksModule } from './webhooks/webhooks.module'
import { StripeModule } from './stripe/stripe.module'
import { CalendlyModule } from './calendly/calendly.module'
import { GoogleAnalyticsModule } from './google-analytics/google-analytics.module'
import { VercelModule } from './vercel/vercel.module'
import { SchedulerModule } from './scheduler/scheduler.module'
import { UserSettingsModule } from './user-settings/user-settings.module'
import { ProjectSettingsModule } from './project-settings/project-settings.module'
import { ProjectOverviewModule } from './project-overview/project-overview.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SupabaseModule,
    ProjectsModule,
    FoldersModule,
    ConnectionsModule,
    AccountsModule,
    ViewsModule,
    WebhooksModule,
    StripeModule,
    CalendlyModule,
    GoogleAnalyticsModule,
    VercelModule,
    SchedulerModule,
    UserSettingsModule,
    ProjectSettingsModule,
    ProjectOverviewModule,
  ],
})
export class AppModule {}
