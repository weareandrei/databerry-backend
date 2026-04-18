import { Module } from '@nestjs/common'
import { PosthogLifecycleService } from './hog-function'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [PosthogLifecycleService],
  exports: [PosthogLifecycleService],
})
export class PosthogLifecycleModule {}
