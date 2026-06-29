import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { StripeRepository } from './stripe.repository'

@Module({
  imports: [SupabaseModule],
  providers: [StripeRepository],
  exports: [StripeRepository],
})
export class StripeRepositoriesModule {}
