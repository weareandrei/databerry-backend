import { Module } from '@nestjs/common'
import { PosthogViewsController } from './views.controller'
import { PosthogViewsService } from './views.service'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  controllers: [PosthogViewsController],
  providers: [PosthogViewsService],
  exports: [PosthogViewsService],
})
export class PosthogViewsModule {}
