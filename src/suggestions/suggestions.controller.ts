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
import { SuggestionsService } from './suggestions.service'

interface SuggestionPostBody {
  /** Free-text feature suggestion. Trimmed + length-capped server-side. */
  suggestion?: string
}

const MAX_SUGGESTION_LEN = 5_000
const MIN_SUGGESTION_LEN = 3

/**
 * `POST /suggestions` — authenticated only. Widget lives in the
 * sidebar of `/hub`, so the caller is always a known user. Same
 * defensive shape as `POST /feedback`:
 *   - rating-style body, only one user-supplied string ("suggestion").
 *   - User email is fetched server-side from the auth record (not
 *     trusted from the body) so the email body can't be spoofed.
 *   - Length-bounded — too-short rejected as fat-finger submissions,
 *     too-long rejected because the inbox is meant for triage, not
 *     manifestos.
 */
@Controller('suggestions')
export class SuggestionsController {
  private readonly logger = new Logger(SuggestionsController.name)

  constructor(
    private readonly suggestionsService: SuggestionsService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @UseGuards(SupabaseAuthGuard)
  @Post()
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() body: SuggestionPostBody,
  ) {
    if (!this.suggestionsService.isConfigured()) {
      throw new HttpException(
        'Email service is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    const suggestion = (body.suggestion ?? '').trim()
    if (suggestion.length < MIN_SUGGESTION_LEN) {
      throw new BadRequestException(
        `Suggestion is too short — please share a few more words.`,
      )
    }
    if (suggestion.length > MAX_SUGGESTION_LEN) {
      throw new BadRequestException(
        `Suggestion is too long — keep it under ${MAX_SUGGESTION_LEN} characters.`,
      )
    }

    // Look up the user's email server-side. Same pattern as the
    // feedback endpoint: never trust a client-supplied email — a
    // hostile user could put any address there and the inbox would
    // show a spoofed sender.
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
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Supabase auth.admin.getUserById threw: ${detail}`)
    }

    try {
      const { id } = await this.suggestionsService.sendSuggestion({
        userId: req.authUser.id,
        userEmail,
        suggestion,
      })
      return { id, delivered: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.error(`POST /suggestions failed: ${detail}`)
      throw new HttpException(
        'Could not send your suggestion. Please try again in a moment.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
  }
}
