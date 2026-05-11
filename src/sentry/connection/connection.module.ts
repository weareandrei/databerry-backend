import { Module } from '@nestjs/common'
import { SentryOAuthService } from './oauth'
import { SentryConnectionController } from './connection.controller'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [SentryOAuthService],
  controllers: [SentryConnectionController],
  exports: [SentryOAuthService],
})
export class SentryConnectionModule {}
