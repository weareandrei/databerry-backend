import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { Resend } from 'resend'

/**
 * Outgoing-mail service for the public contact form on the landing
 * page. The Resend API key lives only here, in the backend's
 * environment — the frontend posts plain `{ email, message }` JSON
 * to `POST /contact` and never sees the key.
 *
 * Why Resend (vs. SMTP / SendGrid / Mailgun): we already have a
 * Resend account, the SDK is single-import + single-method, the
 * 3k-emails/month free tier is plenty for a contact form, and the
 * delivery story (verified domain → DKIM/SPF) is already solved on
 * `heavenmade.org`.
 *
 * The `from` address is the only sender identity Resend will let us
 * send under (it must match a verified domain in the Resend
 * dashboard). We keep it as `RESEND_FROM` env so changing it is a
 * single env-var swap, not a code deploy.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name)
  private readonly client: Resend | null
  private readonly fromAddress: string
  private readonly toAddress = 'team@heavenmade.org'

  constructor() {
    const apiKey = process.env.RESEND_API_KEY
    this.fromAddress = process.env.RESEND_FROM ?? 'no-reply@heavenmade.org'

    // We don't throw at construction time on missing API key — the
    // module still boots so the rest of the app keeps running. The
    // `isConfigured` check below is what gates actual sends; the
    // controller surfaces 503 when not configured. Same pattern the
    // chat service uses for `ANTHROPIC_API_KEY`.
    this.client = apiKey ? new Resend(apiKey) : null
    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not set — POST /contact will return 503 until it is configured.',
      )
    }
  }

  isConfigured(): boolean {
    return this.client !== null
  }

  /**
   * Send a contact-form submission to `team@heavenmade.org`. The
   * sender's email goes into the `Reply-To` header so a single
   * "Reply" in the receiving inbox goes straight back to them — no
   * copy-paste from the body needed.
   *
   * Returns `{ id }` from Resend on success. Throws
   * `InternalServerErrorException` on Resend API failure so the
   * controller's catch block can surface a generic 500 to the
   * frontend without leaking the underlying provider error.
   */
  async sendContactMessage(args: {
    fromEmail: string
    message: string
  }): Promise<{ id: string }> {
    if (!this.client) {
      throw new InternalServerErrorException('Email service not configured')
    }

    const { fromEmail, message } = args

    // Plain-text body (no HTML) — keeps deliverability high (HTML-only
    // emails get more spam-flag heat) and keeps the message human-
    // readable in any client. Footer marks the source so a quick
    // glance at the inbox tells you "this came from the website
    // form, not from a personal sender".
    const text =
      `From: ${fromEmail}\n\n` +
      `${message}\n\n` +
      `—\nSent via the databerry.app contact form`

    const subject = `Databerry contact: ${fromEmail}`

    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: this.toAddress,
        replyTo: fromEmail,
        subject,
        text,
      })

      // Resend returns `{ data: { id }, error }` — the SDK's union
      // shape needs guarding before we treat the success path.
      if (result.error) {
        this.logger.error(
          `Resend rejected contact send: ${result.error.name} — ${result.error.message}`,
        )
        throw new InternalServerErrorException('Failed to send contact email')
      }

      this.logger.log(
        `✓ Contact email sent  id=${result.data?.id ?? '?'}  reply_to=${fromEmail}`,
      )
      return { id: result.data?.id ?? '' }
    } catch (err) {
      // `result.error` doesn't always trigger; the SDK can also throw
      // outright (network failure, malformed payload). We log the
      // server-side detail but only surface a generic message to the
      // caller — Resend's underlying error string sometimes contains
      // operational hints we'd rather not echo back to a public
      // endpoint.
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.logger.error(`Resend send threw: ${detail}`)
      throw new InternalServerErrorException('Failed to send contact email')
    }
  }
}
