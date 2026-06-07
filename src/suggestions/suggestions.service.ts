import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { Resend } from 'resend'

/**
 * Feature-suggestion delivery. Same Resend-backed pattern the
 * `FeedbackService` uses — point a private inbox at the firehose
 * of unfiltered user thoughts, let the founder triage.
 *
 * Why a separate service from `FeedbackService`:
 *   - Different signal. Feedback is sentiment ("how are you
 *     finding Databerry?"); suggestions are concrete asks ("can
 *     you add X"). Mixing them in one inbox makes it harder to
 *     keep a real product backlog from the latter without the
 *     ambient grumbling of the former drowning it out.
 *   - Different envelope. Subject line, framing, body shape all
 *     differ enough that a single `sendSomething(args, type)`
 *     overload would have more `if` branches than payload.
 *
 * The toAddress is the founder's personal inbox, matching the
 * feedback channel. Replace by env var if/when this graduates to
 * a team-distributed mailbox.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name)
  private readonly client: Resend | null
  private readonly fromAddress: string
  private readonly toAddress = 'weareandrei@gmail.com'

  constructor() {
    const apiKey = process.env.RESEND_API_KEY
    this.fromAddress = process.env.RESEND_FROM ?? 'no-reply@heavenmade.org'

    this.client = apiKey ? new Resend(apiKey) : null
    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not set — POST /suggestions will return 503 until it is configured.',
      )
    }
  }

  isConfigured(): boolean {
    return this.client !== null
  }

  /**
   * Mail one suggestion to the founder's inbox. `Reply-To` is the
   * user's email so the inbox-reply pattern works without
   * copy-paste. `userId` is included in the body so two
   * suggestions from the same person are easy to thread mentally
   * even when their displayed email matches another user's.
   */
  async sendSuggestion(args: {
    userId: string
    userEmail: string | null
    suggestion: string
  }): Promise<{ id: string }> {
    if (!this.client) {
      throw new InternalServerErrorException('Email service not configured')
    }

    const { userId, userEmail, suggestion } = args

    const headerLine = userEmail
      ? `From: ${userEmail} (user id: ${userId})`
      : `From: <no email on auth record> (user id: ${userId})`

    const bodyText =
      `${headerLine}\n\n` +
      `Suggestion:\n` +
      `"${suggestion}"\n\n` +
      `—\nSent via the databerry.app sidebar suggestion widget`

    const subject = userEmail
      ? `Databerry suggestion from ${userEmail}`
      : `Databerry suggestion`

    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: this.toAddress,
        ...(userEmail ? { replyTo: userEmail } : {}),
        subject,
        text: bodyText,
      })

      if (result.error) {
        this.logger.error(
          `Resend rejected suggestion send: ${result.error.name} — ${result.error.message}`,
        )
        throw new InternalServerErrorException('Failed to send suggestion email')
      }

      this.logger.log(
        `✓ Suggestion email sent  id=${result.data?.id ?? '?'}  user=${userId}`,
      )
      return { id: result.data?.id ?? '' }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.logger.error(`Resend suggestion send threw: ${detail}`)
      throw new InternalServerErrorException('Failed to send suggestion email')
    }
  }
}
