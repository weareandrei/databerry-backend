import {
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
import { ChatService, type ChatMessageParam } from './chat.service'
import type { AuthenticatedRequest } from '../common/types'

interface ChatPostBody {
  messages?: ChatMessageParam[]
  tz?: string | null
}

/**
 * `POST /chat` — single endpoint for the Ask-AI page. Behind
 * `SupabaseAuthGuard` like every other authenticated route, so the
 * Gemini call (and all the tools it triggers) run as the
 * authenticated user.
 *
 * Always returns JSON. Top-level try/catch makes sure the client
 * gets a structured error message even if the SDK or a tool throws
 * — otherwise empty 500s would surface as "Unexpected end of JSON
 * input" on the frontend.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name)

  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body() body: ChatPostBody, @Req() req: AuthenticatedRequest) {
    if (!this.chatService.isConfigured()) {
      throw new HttpException(
        'Server is missing GEMINI_API_KEY',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    const { messages, tz } = body
    if (!messages || !Array.isArray(messages)) {
      throw new HttpException(
        'Request body must include `messages: MessageParam[]`',
        HttpStatus.BAD_REQUEST,
      )
    }

    try {
      const result = await this.chatService.runAgent(
        messages,
        req.authUser.id,
        tz ?? null,
      )
      return result
    } catch (err) {
      // Log the full thing for ops (name + stack); send only the
      // clean, already-extracted message to the client. The chat
      // service already parses Gemini's JSON error envelopes via
      // `extractGeminiErrorMessage`, so `err.message` is already
      // human-readable. Dropping the legacy `Server error —`
      // prefix means the frontend renders the message verbatim
      // (in a red bubble), which reads as plain English instead
      // of "Server error — ApiError: { huge json }".
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `chat failed: ${err instanceof Error ? err.name : 'unknown'}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      )
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR)
    }
  }
}
