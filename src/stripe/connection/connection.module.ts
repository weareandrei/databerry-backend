import { Module } from '@nestjs/common'
import { StripeConnectionController } from './connection.controller'
import { StripeOAuthService } from './oauth'
import { SupabaseModule } from '../../supabase/supabase.module'
import { StripeSyncModule } from '../sync/sync.module'

@Module({
  imports: [SupabaseModule, StripeSyncModule],
  controllers: [StripeConnectionController],
  providers: [StripeOAuthService],
})
export class StripeConnectionModule {}
