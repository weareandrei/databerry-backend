import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { FeedbackController } from './feedback.controller'
import { FeedbackService } from './feedback.service'

/**
 * Satisfaction-survey delivery module — `POST /feedback`. Auth-only
 * (the widget lives inside `/hub`). Pulls the user's email from
 * Supabase admin auth so the founder's inbox sees the real sender
 * even though the request body doesn't include it.
 *
 * Imports `SupabaseModule` for the admin-client lookup; everything
 * else is self-contained (controller + Resend service).
 */
@Module({
  imports: [SupabaseModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
