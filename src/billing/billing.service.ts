import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import Stripe from 'stripe'
import { getPrimaryFrontendUrl } from '../common/frontend-url'
import { BillingRepository } from './billing.repository'

/**
 * Billing service — Databerry charging users for subscriptions.
 *
 * Distinct from `StripeWebhookService` / `StripeConnectService`,
 * which deal with the user's OWN Stripe (their Connect account
 * where their customers pay them, used as a data source). This
 * service deals with OUR Stripe — the platform account where
 * Databerry receives subscription payments from its users.
 *
 * Two responsibilities:
 *   1. Create a Stripe Checkout Session for a given plan, returning
 *      the hosted-checkout URL the frontend redirects the browser
 *      to. Handles Customer creation / reuse: a user's first
 *      upgrade attempt creates a Stripe Customer and persists the
 *      id on `accounts.stripe_customer_id`; subsequent upgrades
 *      reuse it so the Stripe Dashboard doesn't accumulate
 *      duplicate customers per user.
 *   2. Process subscription lifecycle webhooks (`customer.subscription.created`,
 *      `customer.subscription.updated`, `customer.subscription.deleted`):
 *      map the Stripe customer back to the Databerry account and
 *      update `accounts.plan_id` based on the subscription's
 *      current price.
 *
 * Env vars consumed:
 *   - STRIPE_SECRET_KEY             — platform secret (sk_test_… / sk_live_…)
 *   - STRIPE_BILLING_WEBHOOK_SECRET — webhook signing secret for THIS
 *                                     endpoint (distinct from the
 *                                     Connect webhook secret used by
 *                                     `StripeWebhookService`)
 *   - FRONTEND_URL                  — comma-separated list of allowed
 *                                     frontend origins (CORS). For success/
 *                                     cancel redirects we use only the
 *                                     FIRST entry via `getPrimaryFrontendUrl()`,
 *                                     so the canonical redirect domain is
 *                                     whichever URL you list first.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name)
  private stripe: Stripe | null = null

  constructor(private readonly billingRepository: BillingRepository) {}

  /**
   * Lazy Stripe client — initialised on first use rather than at
   * boot so a missing `STRIPE_SECRET_KEY` doesn't crash the whole
   * NestJS process (only the billing endpoints fail). Matches the
   * pattern `StripeWebhookService` uses.
   */
  private getStripe(): Stripe {
    if (this.stripe) return this.stripe
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set')
    }
    this.stripe = new Stripe(key)
    return this.stripe
  }

  /**
   * Create a Checkout Session for `planId` on behalf of `userId`.
   *
   * Flow:
   *   1. Look up the plan in `subscriptions` to get the
   *      `stripe_price_id` (+ optional `stripe_intro_coupon_id`).
   *      Reject early if either: the plan doesn't exist, the plan
   *      is `free` (nothing to checkout), or the plan hasn't been
   *      wired in Stripe yet (price id null).
   *   2. Ensure the user has a Stripe Customer — create one and
   *      persist the id on `accounts.stripe_customer_id` if this is
   *      the first time. Pass the user's email so receipts go to
   *      the right place; pass `metadata.databerry_user_id` so
   *      webhooks can map the customer back to us without a DB
   *      lookup in the hot path.
   *   3. Create the Checkout Session with `mode: 'subscription'`,
   *      the resolved price, the intro coupon (if any), and our
   *      success / cancel URLs.
   *
   * Returns the hosted-checkout URL — the controller forwards this
   * to the client which `window.location = url` redirects.
   */
  async createCheckoutSession(
    userId: string,
    userEmail: string | undefined,
    planId: string,
  ): Promise<{ url: string }> {
    const { data: plan, error: planError } = await this.billingRepository.findPlanById(planId)

    if (planError || !plan) {
      throw new NotFoundException(`Unknown plan id: ${planId}`)
    }
    if (plan.id === 'free') {
      throw new BadRequestException('Cannot checkout the free plan')
    }
    if (!plan.stripe_price_id) {
      throw new BadRequestException(
        `Plan ${planId} is missing stripe_price_id — populate it in the subscriptions table`,
      )
    }

    const customerId = await this.getOrCreateCustomer(userId, userEmail)

    const appUrl = getPrimaryFrontendUrl()
    const successUrl = `${appUrl}/hub?upgraded=${planId}&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${appUrl}/hub?upgrade_cancelled=1`

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { databerry_user_id: userId, plan_id: planId },
      subscription_data: {
        metadata: { databerry_user_id: userId, plan_id: planId },
      },
    }

    if (plan.stripe_intro_coupon_id) {
      params.discounts = [{ coupon: plan.stripe_intro_coupon_id }]
    } else {
      params.allow_promotion_codes = true
    }

    const session = await this.getStripe().checkout.sessions.create(params)

    if (!session.url) {
      throw new Error('Stripe returned a session without a URL')
    }

    this.logger.log(
      `Checkout session  user=${userId}  plan=${planId}  session=${session.id}`,
    )

    return { url: session.url }
  }

  private async getOrCreateCustomer(
    userId: string,
    userEmail: string | undefined,
  ): Promise<string> {
    const { data: account, error } =
      await this.billingRepository.findStripeCustomerId(userId)

    if (error) {
      throw new Error(`Accounts row missing for user ${userId}: ${error.message}`)
    }

    if (account.stripe_customer_id) {
      try {
        const cached = await this.getStripe().customers.retrieve(
          account.stripe_customer_id,
        )
        if (!cached.deleted) return cached.id
        this.logger.warn(
          `Stripe customer ${account.stripe_customer_id} was deleted — creating a fresh one`,
        )
      } catch (err) {
        const stripeErr = err as { code?: string }
        if (stripeErr.code !== 'resource_missing') throw err
        this.logger.warn(
          `Cached customer ${account.stripe_customer_id} not found in current Stripe mode — creating a fresh one`,
        )
      }
    }

    const customer = await this.getStripe().customers.create({
      email: userEmail,
      metadata: { databerry_user_id: userId },
    })

    const { error: updateError } = await this.billingRepository.updateStripeCustomerId(
      userId,
      customer.id,
    )

    if (updateError) {
      this.logger.warn(
        `Stripe customer ${customer.id} created but DB write failed: ${updateError.message}`,
      )
    }

    return customer.id
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET
    if (!webhookSecret) {
      this.logger.error(
        'STRIPE_BILLING_WEBHOOK_SECRET not set — skipping billing webhook',
      )
      return
    }

    this.logger.debug(
      `Billing webhook signature check  ` +
        `bodyIsBuffer=${Buffer.isBuffer(rawBody)}  ` +
        `bodySize=${rawBody?.length ?? 'undefined'}  ` +
        `signaturePresent=${!!signature}  ` +
        `signaturePrefix=${signature?.slice(0, 16) ?? 'n/a'}  ` +
        `secretPrefix=${webhookSecret.slice(0, 12)}…`,
    )

    let event: Stripe.Event
    try {
      event = this.getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      )
    } catch (err) {
      this.logger.error(
        `Billing webhook signature verification failed: ${String(err)}  ` +
          `(see DEBUG diagnostic line above for body/secret state)`,
      )
      throw new BadRequestException('Invalid Stripe signature')
    }

    this.logger.log(`Billing webhook  type=${event.type}`)

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        await this.handleSubscriptionUpsert(sub)
        return
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        await this.handleSubscriptionDeleted(sub)
        return
      }
      default:
        this.logger.debug(`Unhandled billing event type: ${event.type}`)
        return
    }
  }

  private async handleSubscriptionUpsert(sub: Stripe.Subscription): Promise<void> {
    const userIdFromMetadata = sub.metadata?.databerry_user_id ?? null
    let userId: string | null = userIdFromMetadata

    if (!userId) {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id

      const { data: account, error } =
        await this.billingRepository.findUserIdByStripeCustomerId(customerId)

      if (error || !account) {
        this.logger.warn(
          `Subscription ${sub.id} has no matching account (customer=${customerId})`,
        )
        return
      }
      userId = account.user_id
    }

    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      this.logger.debug(
        `Skipping sub upsert for terminal state: ${sub.status} sub=${sub.id}`,
      )
      return
    }

    const priceId = sub.items.data[0]?.price.id
    if (!priceId) {
      this.logger.warn(`Subscription ${sub.id} has no price — skipping`)
      return
    }

    const { data: plan, error: planError } =
      await this.billingRepository.findPlanByStripePriceId(priceId)

    if (planError || !plan) {
      this.logger.warn(
        `Subscription ${sub.id} uses unknown stripe_price_id=${priceId}`,
      )
      return
    }

    const { error: updateError } = await this.billingRepository.updateSubscription(
      userId!,
      plan.id,
      sub.id,
    )

    if (updateError) {
      this.logger.error(
        `Failed to update plan for user ${userId}: ${updateError.message}`,
      )
      throw updateError
    }

    this.logger.log(
      `Upserted subscription  user=${userId}  plan=${plan.id}  sub=${sub.id}`,
    )
  }

  private async handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const userIdFromMetadata = sub.metadata?.databerry_user_id ?? null
    let userId: string | null = userIdFromMetadata

    if (!userId) {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      const { data: account } =
        await this.billingRepository.findUserIdByStripeCustomerId(customerId)
      userId = account?.user_id ?? null
    }

    if (!userId) {
      this.logger.warn(`Cancelled subscription ${sub.id} — no matching account`)
      return
    }

    const { error } = await this.billingRepository.revertToFree(userId)

    if (error) {
      this.logger.error(
        `Failed to revert plan on cancel for user ${userId}: ${error.message}`,
      )
      throw error
    }

    this.logger.log(`Reverted to free  user=${userId}  sub=${sub.id}`)
  }
}
