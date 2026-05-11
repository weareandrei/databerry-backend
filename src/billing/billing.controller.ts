import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBody,
  Req,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { BillingService } from './billing.service'

/**
 * Billing HTTP surface — two endpoints:
 *
 *   POST /billing/checkout-session
 *     Auth-required. Body: `{ planId }`. Returns `{ url }` —
 *     the hosted-checkout URL the frontend redirects the browser
 *     to (`window.location = url`). Wraps `BillingService`'s
 *     customer-get-or-create + Stripe Checkout Session creation.
 *
 *   POST /billing/webhook
 *     NO auth — Stripe calls this directly. Verified by the
 *     `STRIPE_BILLING_WEBHOOK_SECRET` signature inside the
 *     service. Handles subscription lifecycle events (created /
 *     updated / deleted) and updates `accounts.plan_id` accordingly.
 *
 * The webhook endpoint is under `/billing/` (not `/webhooks/`)
 * specifically so the Stripe Dashboard configuration for the
 * billing webhook is unambiguous — `/webhooks/stripe` is already
 * taken by the Connect webhook that listens to `charge.*` events
 * from users' own Stripe accounts.
 */
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name)

  constructor(private readonly billingService: BillingService) {}

  @Post('checkout-session')
  @UseGuards(SupabaseAuthGuard)
  async createCheckoutSession(
    @Req() req: any,
    @Body() body: { planId?: string },
  ): Promise<{ url: string }> {
    if (!body.planId || typeof body.planId !== 'string') {
      throw new BadRequestException('Missing planId in request body')
    }
    return this.billingService.createCheckoutSession(
      req.authUser.id,
      req.authUser.email,
      body.planId,
    )
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @RawBody() rawBody: Buffer,
    @Headers('stripe-signature') sig: string,
  ): Promise<{ ok: true }> {
    if (!sig) throw new BadRequestException('Missing stripe-signature header')

    // Fire-and-forget — Stripe expects a fast 200 back. Errors are
    // logged inside the service; we don't want a transient DB
    // hiccup to make the webhook endpoint look broken from
    // Stripe's perspective. For permanent failures (bad signature),
    // the service throws and the BadRequestException reaches the
    // caller — that we DO want Stripe to see.
    this.billingService
      .handleWebhook(rawBody, sig)
      .catch(err =>
        this.logger.error('handleBillingWebhook failed', err?.message),
      )

    return { ok: true }
  }
}
