import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import Stripe from 'stripe'
import { SupabaseService } from '../../supabase/supabase.service'
import { handleChargeEvent } from './events/charge-event'

/**
 * Stripe webhook entrypoint.
 *
 * Events we care about:
 *   - charge.succeeded   → first persistence of a successful charge + line items
 *   - charge.updated     → status / metadata changes (e.g. dispute → succeeded)
 *   - charge.refunded    → updates `amount_refunded` (refund views are out
 *                          of scope for v1, but the data is captured for
 *                          when they ship)
 *
 * All three flow through the same `handleChargeEvent` helper because they
 * carry a Charge object and our writes are idempotent — last-write-wins on
 * the same `charge.id`.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  async handleStripeEvent(rawBody: Buffer, sig: string): Promise<void> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
      this.logger.error('  ✗ STRIPE_WEBHOOK_SECRET not set — skipping')
      return
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '')

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
    } catch (err) {
      this.logger.error(`Stripe signature verification failed: ${String(err)}`)
      // Surfaces as 400 to Stripe — they retry on 5xx, not 4xx, which is
      // what we want for a malformed signature (retrying won't fix it).
      throw new BadRequestException('Invalid Stripe signature')
    }

    this.logger.log(
      `Stripe webhook  type=${event.type}  account=${event.account ?? '(platform)'}`,
    )

    const client = this.supabaseService.getClient()

    switch (event.type) {
      case 'charge.succeeded':
      case 'charge.updated':
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        await handleChargeEvent(charge, event.account ?? null, client, this.logger)
        return
      }
      default:
        // Unhandled event type — log and ignore. Stripe sends many event
        // types we don't subscribe to; quiet drop is correct.
        return
    }
  }
}
