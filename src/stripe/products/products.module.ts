import { Module } from '@nestjs/common'
import { SupabaseModule } from '../../supabase/supabase.module'
import { StripeProductsController } from './products.controller'
import { StripeProductsService } from './products.service'

/**
 * Per-Stripe-connection product filter — list available products, save the
 * selected subset for a connection, and surface backfill status while the
 * picker modal is waiting for the 90-day import to finish.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [StripeProductsController],
  providers: [StripeProductsService],
  exports: [StripeProductsService],
})
export class StripeProductsModule {}
