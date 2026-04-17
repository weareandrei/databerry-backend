import { Module } from '@nestjs/common'
import { SupabaseModule } from './supabase/supabase.module'
import { ProjectsModule } from './projects/projects.module'
import { FoldersModule } from './folders/folders.module'
import { ConnectionsModule } from './connections/connections.module'
import { AccountsModule } from './accounts/accounts.module'
import { ViewsModule } from './views/views.module'
import { WebhooksModule } from './webhooks/webhooks.module'
import { StripeModule } from './stripe/stripe.module'
import { StripeManualModule } from './stripe-manual/stripe-manual.module'
import { CalendlyModule } from './calendly/calendly.module'
import { GoogleAnalyticsModule } from './google-analytics/google-analytics.module'

@Module({
  imports: [
    SupabaseModule,
    ProjectsModule,
    FoldersModule,
    ConnectionsModule,
    AccountsModule,
    ViewsModule,
    WebhooksModule,
    StripeModule,
    StripeManualModule,
    CalendlyModule,
    GoogleAnalyticsModule,
  ],
})
export class AppModule {}
