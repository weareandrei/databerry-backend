import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common'
import { ContactService } from './contact.service'

interface ContactPostBody {
  email?: string
  message?: string
  /**
   * Honeypot field — visible only to bots that auto-fill every input
   * they find. Real users never touch this. Any non-empty value =>
   * silently 200 with a fake id (don't tell the bot it failed; just
   * absorb the submission and move on). Field name is intentionally
   * generic ("website") so the bot has no reason to skip it.
   */
  website?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_MESSAGE_LEN = 5_000
const MIN_MESSAGE_LEN = 10

/**
 * `POST /contact` — public endpoint (no auth). Receives the
 * landing-page contact form, validates the email + message, and
 * forwards to `team@heavenmade.org` via Resend (server-side).
 *
 * Public on purpose: the form is meant for unauthenticated visitors.
 * To prevent abuse:
 *   - Honeypot field (silently swallows obvious bot fills)
 *   - Length cap on `message` (5k chars; long enough for any real
 *     question, short enough to keep the inbox readable)
 *   - Resend itself enforces sending-domain auth + rate limits
 *   - We never echo provider errors back to the client (would help
 *     an attacker probe our setup)
 */
@Controller('contact')
export class ContactController {
  private readonly logger = new Logger(ContactController.name)

  constructor(private readonly contactService: ContactService) {}

  @Post()
  async send(@Body() body: ContactPostBody) {
    // Honeypot: any non-empty value means a bot filled the hidden
    // field. Pretend we processed it (200 + fake id) so the bot has
    // no signal that its attack failed and doesn't iterate. Log it
    // so we can spot patterns if they emerge.
    if (body.website && body.website.trim().length > 0) {
      this.logger.warn(`Honeypot triggered — body.website="${body.website.slice(0, 40)}"`)
      return { id: 'noop', delivered: false }
    }

    if (!this.contactService.isConfigured()) {
      throw new HttpException(
        'Email service is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    const email = (body.email ?? '').trim()
    const message = (body.message ?? '').trim()

    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException('Please provide a valid email address.')
    }
    if (message.length < MIN_MESSAGE_LEN) {
      throw new BadRequestException(
        `Message is too short — please write at least ${MIN_MESSAGE_LEN} characters.`,
      )
    }
    if (message.length > MAX_MESSAGE_LEN) {
      throw new BadRequestException(
        `Message is too long — keep it under ${MAX_MESSAGE_LEN} characters.`,
      )
    }

    try {
      const { id } = await this.contactService.sendContactMessage({
        fromEmail: email,
        message,
      })
      return { id, delivered: true }
    } catch (err) {
      // Don't leak provider details back to the public endpoint. The
      // service has already logged the underlying error server-side.
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.error(`POST /contact failed: ${detail}`)
      throw new HttpException(
        'Could not send your message. Please try again or email team@heavenmade.org directly.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
  }
}
