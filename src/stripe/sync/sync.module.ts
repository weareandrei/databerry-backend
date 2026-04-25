import { Module } from '@nestjs/common'
import { SupabaseModule } from '../../supabase/supabase.module'
import { StripeBackfillService } from './backfill.service'
import { StripeReconcileService } from './reconcile.service'

/**
 * Stripe data-sync layer (backfill + nightly reconcile + line-item resolution).
 * Read endpoints (`views`, `project-overview`) read from Supabase, this module
 * keeps Supabase in sync with Stripe.
 */
@Module({
  imports: [SupabaseModule],
  providers: [StripeBackfillService, StripeReconcileService],
  exports: [StripeBackfillService, StripeReconcileService],
})
export class StripeSyncModule {}
