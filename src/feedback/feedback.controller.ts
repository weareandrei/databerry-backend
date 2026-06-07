import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import type { AuthenticatedRequest } from '../common/types'
import { SupabaseService } from '../supabase/supabase.service'
import { FeedbackService } from './feedback.service'

interface FeedbackPostBody {
  /** 1-5 emoji ladder (1 = very unhappy, 5 = very happy). Required. */
  rating?: number
  /** Optional free-text comment. Capped server-side at 5k chars. */
  message?: string
}

const MAX_MESSAGE_LEN = 5_000

/**
 * `POST /feedback` — authenticated only. The widget lives inside
 * `/hub` so we treat the caller as a known user and skip the
 * honeypot / public-form anti-abuse hardening the contact endpoint
 * needs. The user's email is resolved server-side from their auth
 * record (not trusted from the body) so the email body can't be
 * spoofed to look like it came from someone else.
 *
 * Validation:
 *   - `rating` must be an integer 1-5.
 *   - `message` is optional. Trimmed + length-capped if present.
 *
 * Recipient is the founder's personal inbox (set in
 * `FeedbackService.toAddress`). See that file's docblock for why
 * this isn't routed through the public support alias.
 */
@Controller('feedback')
export class FeedbackController {
  private readonly logger = new Logger(FeedbackController.name)

  constructor(
    private readonly feedbackService: FeedbackService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @UseGuards(SupabaseAuthGuard)
  @Post()
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() body: FeedbackPostBody,
  ) {
    if (!this.feedbackService.isConfigured()) {
      throw new HttpException(
        'Email service is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    // Coerce rating to an int and validate. We round (rather than
    // reject) non-integer numbers because a rogue `4.0` shouldn't
    // be punished — but we still bound-check after rounding so a
    // hostile `99` or `0` bounces.
    const rawRating = body.rating
    if (typeof rawRating !== 'number' || !Number.isFinite(rawRating)) {
      throw new BadRequestException('Rating must be a number between 1 and 5.')
    }
    const rating = Math.round(rawRating)
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5.')
    }

    const messageRaw = (body.message ?? '').trim()
    if (messageRaw.length > MAX_MESSAGE_LEN) {
      throw new BadRequestException(
        `Comment is too long — keep it under ${MAX_MESSAGE_LEN} characters.`,
      )
    }
    const message = messageRaw.length > 0 ? messageRaw : null

    // Resolve the user's email server-side via the Supabase admin
    // client. We can't trust an email passed in the body — a malicious
    // user could spoof another sender. The admin call uses the
    // service-role key so it bypasses RLS and works for any user id.
    let userEmail: string | null = null
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .auth.admin.getUserById(req.authUser.id)
      if (error) {
        this.logger.warn(
          `Could not look up email for user ${req.authUser.id}: ${error.message}`,
        )
      }
      userEmail = data?.user?.email ?? null
    } catch (err) {
      // Non-fatal — feedback can still be sent with the user id alone.
      // We log because a persistent failure here would mean the founder
      // can't tell who's leaving feedback, which is worth noticing.
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Supabase auth.admin.getUserById threw: ${detail}`)
    }

    try {
      const { id } = await this.feedbackService.sendFeedback({
        userId: req.authUser.id,
        userEmail,
        rating,
        message,
      })
      return { id, delivered: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.error(`POST /feedback failed: ${detail}`)
      throw new HttpException(
        'Could not send your feedback. Please try again in a moment.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
  }
}
