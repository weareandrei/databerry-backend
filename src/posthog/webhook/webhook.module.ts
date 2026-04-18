import { Module } from '@nestjs/common'
import { PosthogWebhookService } from './handler'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [PosthogWebhookService],
  exports: [PosthogWebhookService],
})
export class PosthogWebhookModule {}
