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
// Databerry's Sentry *integration* (OAuth + views).
import { SentryModule } from './sentry/sentry.module'
import { VercelModule } from './vercel/vercel.module'
import { SchedulerModule } from './scheduler/scheduler.module'
import { UserSettingsModule } from './user-settings/user-settings.module'
import { ProjectSettingsModule } from './project-settings/project-settings.module'
import { ProjectOverviewModule } from './project-overview/project-overview.module'
import { ChatModule } from './chat/chat.module'
import { ContactModule } from './contact/contact.module'
import { FeedbackModule } from './feedback/feedback.module'
import { SuggestionsModule } from './suggestions/suggestions.module'
import { PeopleModule } from './people/people.module'
import { BillingModule } from './billing/billing.module'
import { FoundersJoinedModule } from './founders-joined/founders-joined.module'

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
    SentryModule,
    VercelModule,
    SchedulerModule,
    UserSettingsModule,
    ProjectSettingsModule,
    ProjectOverviewModule,
    ChatModule,
    ContactModule,
    FeedbackModule,
    SuggestionsModule,
    PeopleModule,
    BillingModule,
    FoundersJoinedModule,
  ],
})
export class AppModule {}
