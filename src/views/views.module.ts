import { Module } from '@nestjs/common'
import { ViewsController } from './views.controller'
import { ViewsService } from './views.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { PosthogModule } from '../posthog/posthog.module'

@Module({
  imports: [SupabaseModule, PosthogModule],
  controllers: [ViewsController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
