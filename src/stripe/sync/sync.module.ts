import { Module } from '@nestjs/common'
import { SupabaseModule } from '../../supabase/supabase.module'
import { StripeBackfillService } from './backfill.service'
import { StripeLiveSyncService } from './live-sync.service'
import { StripeReconcileService } from './reconcile.service'
import { StripeSyncController } from './sync.controller'

/**
 * Stripe data-sync layer:
 *   - `StripeBackfillService`  — initial 90-day import + reconnect gap-fill.
 *   - `StripeReconcileService` — nightly safety net (catches refunds /
 *     missed webhooks over the last 7 days).
 *   - `StripeLiveSyncService`  — dashboard-open quick sync (charges only,
 *     2s ceiling, 60s throttle) and the user-initiated 30-day reload.
 *
 * Read endpoints (`views`, `project-overview`) read from Supabase; this
 * module keeps Supabase in sync with Stripe via the four trigger paths
 * above, all composed on top of `ensureSyncedThrough`.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [StripeSyncController],
  providers: [
    StripeBackfillService,
    StripeReconcileService,
    StripeLiveSyncService,
  ],
  exports: [
    StripeBackfillService,
    StripeReconcileService,
    StripeLiveSyncService,
  ],
})
export class StripeSyncModule {}
