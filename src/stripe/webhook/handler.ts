import { Injectable, Logger } from '@nestjs/common'
import Stripe from 'stripe'
import { SupabaseService } from '../../supabase/supabase.service'
import { handlePaymentSucceeded } from './events/payment-succeeded'

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
      this.logger.error(`  ✗ Stripe signature verification failed\n  ${String(err)}`)
      throw new Error('Invalid Stripe signature')
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  💳 Stripe webhook received')
    console.log(`  type    : ${event.type}`)
    console.log(`  account : ${event.account ?? '(platform)'}`)
    console.log('  payload :', JSON.stringify(event.data.object, null, 4))
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    if (event.type !== 'payment_intent.succeeded') return

    const stripeAccountId = event.account
    if (!stripeAccountId) {
      this.logger.warn('  ⚠ No account field — not a Connect event, skipping')
      return
    }

    const paymentIntent = event.data.object as Stripe.PaymentIntent
    const client = this.supabaseService.getClient()

    await handlePaymentSucceeded(paymentIntent.amount, stripeAccountId, client, this.logger)
  }
}
