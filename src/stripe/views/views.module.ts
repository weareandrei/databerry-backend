import { Module } from '@nestjs/common'
import { StripeViewsController } from './views.controller'
import { StripeViewsService } from './views.service'
import { SupabaseModule } from '../../supabase/supabase.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  controllers: [StripeViewsController],
  providers: [StripeViewsService],
  // Exported so ChatModule's tool handlers can fetch live values /
  // chart data / top customers in-process (no HTTP round-trip).
  exports: [StripeViewsService],
})
export class StripeViewsModule {}
