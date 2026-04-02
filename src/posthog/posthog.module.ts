import { Module } from '@nestjs/common';
import { PosthogService } from './posthog.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [PosthogService],
  exports: [PosthogService],
})
export class PosthogModule {}
