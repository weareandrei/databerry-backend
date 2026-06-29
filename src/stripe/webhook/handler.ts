import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import Stripe from 'stripe'
import { ConnectionsRepository } from '../../connections/connections.repository'
import { StripeRepository } from '../stripe.repository'
import { handleChargeEvent } from './events/charge-event'

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name)

  constructor(
    private readonly stripeRepository: StripeRepository,
    private readonly connectionsRepository: ConnectionsRepository,
  ) {}

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
      throw new BadRequestException('Invalid Stripe signature')
    }

    this.logger.log(
      `Stripe webhook  type=${event.type}  account=${event.account ?? '(platform)'}`,
    )

    switch (event.type) {
      case 'charge.succeeded':
      case 'charge.updated':
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        await handleChargeEvent(
          charge,
          event.account ?? null,
          {
            stripe: this.stripeRepository,
            connections: this.connectionsRepository,
          },
          this.logger,
        )
        return
      }
      default:
        return
    }
  }
}
