import { Module } from '@nestjs/common'
import { PosthogCredentialsService } from './credentials'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [PosthogCredentialsService],
  exports: [PosthogCredentialsService],
})
export class PosthogConnectionModule {}
