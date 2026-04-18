import { Module } from '@nestjs/common'
import { StripeConnectionController } from './connection.controller'
import { StripeOAuthService } from './oauth'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  controllers: [StripeConnectionController],
  providers: [StripeOAuthService],
})
export class StripeConnectionModule {}
