import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { Resend } from 'resend'

/**
 * In-dashboard satisfaction-survey delivery. Mirrors the public
 * `ContactService`: same Resend client pattern, same defensive
 * boot-without-key behaviour, same generic-error-to-the-client
 * stance. The differences are only:
 *
 *   - `toAddress` points at the founder's personal inbox instead of
 *     the support alias (this is a private feedback channel, not a
 *     team-distributed mailbox).
 *   - The body includes the authenticated user's identity (id +
 *     email + optional plan) since the survey only fires from inside
 *     `/hub`, so we know who's speaking.
 *
 * Why a separate service instead of extending `ContactService`:
 * different recipient, different framing, slightly different
 * validation rules. Keeping them split means changing the founder's
 * inbox or the support inbox is a single env / constant tweak with
 * no risk of accidentally cross-wiring the two channels.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name)
  private readonly client: Resend | null
  private readonly fromAddress: string
  /**
   * Personal inbox for founder-only feedback. NOT the public support
   * alias — these messages are deliberately routed away from the
   * team mailbox so the founder sees the raw, unfiltered signal.
   */
  private readonly toAddress = 'weareandrei@gmail.com'

  constructor() {
    const apiKey = process.env.RESEND_API_KEY
    this.fromAddress = process.env.RESEND_FROM ?? 'no-reply@heavenmade.org'

    this.client = apiKey ? new Resend(apiKey) : null
    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not set — POST /feedback will return 503 until it is configured.',
      )
    }
  }

  isConfigured(): boolean {
    return this.client !== null
  }

  /**
   * Send a satisfaction survey result to the founder's inbox. Body
   * is plain-text (deliverability + readability — same reasoning as
   * `ContactService`). `Reply-To` is set to the user's email so a
   * single inbox-reply lands back in their inbox without copy-paste.
   *
   * `rating` is the 1-5 emoji ladder picked in the widget (1 =
   * 😞 very unhappy, 5 = 😄 very happy). `message` is the free-text
   * comment, optional — the widget allows submission without it.
   */
  async sendFeedback(args: {
    userId: string
    userEmail: string | null
    rating: number
    message: string | null
  }): Promise<{ id: string }> {
    if (!this.client) {
      throw new InternalServerErrorException('Email service not configured')
    }

    const { userId, userEmail, rating, message } = args

    const emoji = RATING_EMOJI[rating] ?? '?'
    const ratingLabel = RATING_LABEL[rating] ?? `${rating}/5`

    const headerLine = userEmail
      ? `From: ${userEmail} (user id: ${userId})`
      : `From: <no email on auth record> (user id: ${userId})`

    const bodyText =
      `${headerLine}\n` +
      `Rating: ${rating}/5 ${emoji}  — ${ratingLabel}\n\n` +
      `Comment:\n` +
      `${message ? `"${message}"` : '(no comment provided)'}\n\n` +
      `—\nSent via the databerry.app dashboard feedback widget`

    const subject = `Databerry feedback: ${rating}/5 ${emoji} ${userEmail ? `from ${userEmail}` : ''}`.trim()

    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: this.toAddress,
        // Only set replyTo when we actually have an email — Resend
        // rejects `undefined` strings on some SDK versions, and a
        // bare auth-id reply-to would be useless anyway.
        ...(userEmail ? { replyTo: userEmail } : {}),
        subject,
        text: bodyText,
      })

      if (result.error) {
        this.logger.error(
          `Resend rejected feedback send: ${result.error.name} — ${result.error.message}`,
        )
        throw new InternalServerErrorException('Failed to send feedback email')
      }

      this.logger.log(
        `✓ Feedback email sent  id=${result.data?.id ?? '?'}  rating=${rating}  user=${userId}`,
      )
      return { id: result.data?.id ?? '' }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.logger.error(`Resend feedback send threw: ${detail}`)
      throw new InternalServerErrorException('Failed to send feedback email')
    }
  }
}

/**
 * Display-only mappings for the 1-5 emoji ladder. Keep in sync with
 * the frontend widget's emoji list — the rating number is the
 * source of truth, the emoji/label here are just sugar so the
 * inbox preview reads at a glance.
 */
const RATING_EMOJI: Record<number, string> = {
  1: '😞',
  2: '🙁',
  3: '😐',
  4: '🙂',
  5: '😄',
}

const RATING_LABEL: Record<number, string> = {
  1: 'very unhappy',
  2: 'unhappy',
  3: 'neutral',
  4: 'happy',
  5: 'very happy',
}
