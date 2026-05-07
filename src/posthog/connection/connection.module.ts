import { Module } from '@nestjs/common'
import { PosthogCredentialsService } from './credentials'
import { PosthogConnectionController } from './connection.controller'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  controllers: [PosthogConnectionController],
  providers: [PosthogCredentialsService],
  exports: [PosthogCredentialsService],
})
export class PosthogConnectionModule {}
