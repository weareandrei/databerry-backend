import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { SuggestionsController } from './suggestions.controller'
import { SuggestionsService } from './suggestions.service'

/**
 * Feature-suggestion module — `POST /suggestions`. Auth-only. Pulls
 * the user's email from Supabase admin auth so the founder's inbox
 * sees the real sender even though the body doesn't include it.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsService],
})
export class SuggestionsModule {}
