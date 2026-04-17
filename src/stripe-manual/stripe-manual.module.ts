import { Module } from '@nestjs/common'
import { StripeManualService } from './stripe-manual.service'
import { StripeManualController } from './stripe-manual.controller'
import { SupabaseModule } from '../supabase/supabase.module'
import { ViewsModule } from '../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  providers: [StripeManualService],
  controllers: [StripeManualController],
})
export class StripeManualModule {}
