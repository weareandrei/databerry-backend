import { Module } from '@nestjs/common'
import { StripeViewsController } from './views.controller'
import { StripeViewsService } from './views.service'
import { SupabaseModule } from '../../supabase/supabase.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  controllers: [StripeViewsController],
  providers: [StripeViewsService],
})
export class StripeViewsModule {}
