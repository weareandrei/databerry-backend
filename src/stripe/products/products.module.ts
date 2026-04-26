import { Module } from '@nestjs/common'
import { SupabaseModule } from '../../supabase/supabase.module'
import { StripeSyncModule } from '../sync/sync.module'
import { StripeProductsController } from './products.controller'
import { StripeProductsService } from './products.service'

/**
 * Per-Stripe-connection product filter — list available products, save the
 * selected subset for a connection, and surface backfill status while the
 * picker modal is waiting for the 90-day import to finish.
 *
 * Imports `StripeSyncModule` so the controller can expose a "retry backfill"
 * action when a Restricted Key was missing scopes (or any other reason the
 * import failed).
 */
@Module({
  imports: [SupabaseModule, StripeSyncModule],
  controllers: [StripeProductsController],
  providers: [StripeProductsService],
  exports: [StripeProductsService],
})
export class StripeProductsModule {}
