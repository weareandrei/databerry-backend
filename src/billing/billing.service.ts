import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import Stripe from 'stripe'
import { SupabaseService } from '../supabase/supabase.service'
import { getPrimaryFrontendUrl } from '../common/frontend-url'

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

  constructor(private readonly supabaseService: SupabaseService) {}

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
    const client = this.supabaseService.getClient()

    // 1. Plan lookup
    const { data: plan, error: planError } = await client
      .from('subscriptions')
      .select('id, name, stripe_price_id, stripe_intro_coupon_id')
      .eq('id', planId)
      .single()

    if (planError || !plan) {
      throw new NotFoundException(`Unknown plan id: ${planId}`)
    }
    if (plan.id === 'free') {
      throw new BadRequestException('Cannot checkout the free plan')
    }
    if (!plan.stripe_price_id) {
      // Plan exists in our catalog but hasn't had Stripe IDs wired
      // up yet. Loud error rather than crashing inside Stripe's API
      // call — easier to spot in logs during initial setup.
      throw new BadRequestException(
        `Plan ${planId} is missing stripe_price_id — populate it in the subscriptions table`,
      )
    }

    // 2. Customer get-or-create
    const customerId = await this.getOrCreateCustomer(userId, userEmail)

    // 3. Build + create Checkout Session.
    //
    // `getPrimaryFrontendUrl()` takes the FIRST entry of the comma-
    // separated FRONTEND_URL allowlist — see `common/frontend-url.ts`.
    // The raw `process.env.FRONTEND_URL` would interpolate the whole
    // comma-joined list ("https://www.databerry.app,https://databerry.app")
    // straight into the Stripe success_url, producing the malformed
    // redirect Stripe happily 302's the user into. Same helper the
    // OAuth callback controllers use.
    const appUrl = getPrimaryFrontendUrl()
    // `?upgraded={CHECKOUT_SESSION_ID}` — frontend uses presence of
    // the param to refresh `useAccount` after the redirect lands.
    // The session id itself isn't read; treating it as a flag.
    const successUrl = `${appUrl}/hub?upgraded=${planId}&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${appUrl}/hub?upgrade_cancelled=1`

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Stash the chosen plan id on the session so the webhook can
      // disambiguate even if the price id were ambiguous (defensive —
      // currently each price maps 1:1 to a plan, but this is a
      // cheap belt for free).
      metadata: { databerry_user_id: userId, plan_id: planId },
      // Mirror metadata onto the subscription so subsequent
      // `customer.subscription.updated` events carry the user id
      // without us having to do a customer-id → user-id lookup.
      subscription_data: {
        metadata: { databerry_user_id: userId, plan_id: planId },
      },
    }

    // `allow_promotion_codes` and `discounts` are mutually exclusive on
    // Stripe's Checkout API — and "mutually exclusive" means the field
    // can't be SPECIFIED alongside the other, even with `false`. We
    // previously set `allow_promotion_codes: false` whenever an intro
    // coupon was configured, expecting Stripe to read that as "no
    // promo input UI"; instead Stripe rejected the whole request with
    // `StripeInvalidRequestError: You may only specify one of these
    // parameters`. The fix is to OMIT `allow_promotion_codes` from
    // the params entirely in the intro-coupon branch.
    if (plan.stripe_intro_coupon_id) {
      params.discounts = [{ coupon: plan.stripe_intro_coupon_id }]
    } else {
      // No intro coupon → let the user type their own promo code at
      // checkout (Stripe auto-validates).
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

  /**
   * Resolve the user's Stripe Customer, creating one if missing
   * and persisting the id on `accounts.stripe_customer_id` so the
   * next call short-circuits.
   *
   * The persisted-id path is the hot path — only fresh accounts
   * (or accounts created before this code shipped) take the
   * "create on Stripe + write back to DB" branch.
   *
   * Self-healing on mode flip: if the cached customer id doesn't
   * exist in Stripe (e.g. the id was created in test mode but
   * STRIPE_SECRET_KEY is now a live key, or vice versa), we drop
   * the cache and create a fresh customer in the current mode.
   * Without this branch, dev would have to manually `UPDATE
   * accounts SET stripe_customer_id = NULL` every time they flip
   * modes, which is the kind of papercut that wastes hours.
   */
  private async getOrCreateCustomer(
    userId: string,
    userEmail: string | undefined,
  ): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data: account, error } = await client
      .from('accounts')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single()

    if (error) {
      // The `handle_new_user` trigger should have created the row;
      // if it didn't, that's a serious state bug — fail loud.
      throw new Error(`Accounts row missing for user ${userId}: ${error.message}`)
    }

    if (account.stripe_customer_id) {
      // Verify the cached id still resolves in the current mode.
      // Cheap-ish call (one Stripe GET) but it saves the user from
      // a confusing "No such customer" failure later in the
      // Checkout-Session create call. If the lookup fails with
      // `resource_missing`, fall through to the create branch;
      // any other error re-throws.
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

    const { error: updateError } = await client
      .from('accounts')
      .update({ stripe_customer_id: customer.id })
      .eq('user_id', userId)

    if (updateError) {
      // Soft-fail: we have the customer id in hand, return it even
      // though the DB write didn't land. Next checkout will create
      // a duplicate customer (annoying but recoverable — Stripe lets
      // us merge customers in the dashboard).
      this.logger.warn(
        `Stripe customer ${customer.id} created but DB write failed: ${updateError.message}`,
      )
    }

    return customer.id
  }

  /**
   * Webhook entrypoint — verifies the Stripe signature, then
   * dispatches to the right handler based on event type.
   *
   * Uses `STRIPE_BILLING_WEBHOOK_SECRET`, distinct from the secret
   * used by `StripeWebhookService` (which receives Connect events
   * from the user's own Stripe accounts). The two webhook endpoints
   * are separate in the Stripe Dashboard with separate secrets,
   * since they listen to different event sets.
   *
   * Events we handle:
   *   - customer.subscription.created  → set plan_id to the matching plan
   *   - customer.subscription.updated  → same (handles plan changes)
   *   - customer.subscription.deleted  → revert plan_id to 'free'
   *
   * Everything else is logged + ignored. Stripe will retry 5xx
   * indefinitely; we return 200 on every recognised event (even
   * "not handled here") so the dashboard doesn't fill with retry
   * noise from unrelated event types.
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET
    if (!webhookSecret) {
      this.logger.error(
        'STRIPE_BILLING_WEBHOOK_SECRET not set — skipping billing webhook',
      )
      return
    }

    // Pre-verify diagnostics — emitted on EVERY event so the next
    // signature failure has enough context to debug without code
    // changes. Cheap (synchronous string ops) and only the first
    // few chars of each secret/signature so production logs stay
    // safe to share. The classic failure modes show up here:
    //
    //   1. `bodyIsBuffer=false`               → body parser ate the
    //                                            raw bytes. Check
    //                                            `rawBody: true` in
    //                                            main.ts + that no
    //                                            JSON middleware
    //                                            runs before us.
    //   2. `bodySize=0` or `=undefined`        → @RawBody() returned
    //                                            empty. Same root
    //                                            cause as #1.
    //   3. `signaturePresent=false`            → Stripe didn't send
    //                                            the header. Almost
    //                                            always a misconfigured
    //                                            proxy / CDN strip.
    //   4. `secretPrefix` doesn't match the    → wrong env var. The
    //      one in Stripe Dashboard               most common cause —
    //                                            see comment below.
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
      // Surface the Stripe error message verbatim — it usually
      // names the failure mode ("No signatures found matching…"
      // vs "Timestamp outside the tolerance zone…" vs etc.). The
      // diagnostic line above already has the body / signature /
      // secret-prefix context, so the two lines together fully
      // pin down where to look.
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

  /**
   * Subscription created OR updated. We resolve the price → plan
   * via the `subscriptions` table (the same `stripe_price_id`
   * column the Checkout Session used to create the subscription)
   * and persist on the account row.
   *
   * Idempotent — repeated events with the same payload converge on
   * the same state. Stripe DOES retry on transient failures so
   * idempotency is required, not optional.
   */
  private async handleSubscriptionUpsert(sub: Stripe.Subscription): Promise<void> {
    const client = this.supabaseService.getClient()

    // Find the user. Prefer the metadata trail (set during Checkout
    // creation in `subscription_data.metadata`); fall back to the
    // customer-id lookup if metadata is missing (e.g. subscription
    // created outside our flow via the Stripe Dashboard).
    const userIdFromMetadata = sub.metadata?.databerry_user_id ?? null
    let userId: string | null = userIdFromMetadata

    if (!userId) {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id

      const { data: account, error } = await client
        .from('accounts')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (error || !account) {
        this.logger.warn(
          `Subscription ${sub.id} has no matching account (customer=${customerId})`,
        )
        return
      }
      userId = account.user_id
    }

    // Cancelled-but-not-yet-expired subscriptions stay on their
    // current plan until period end. Only act on terminal states
    // here; the `deleted` event handles the actual revert.
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      this.logger.debug(
        `Skipping sub upsert for terminal state: ${sub.status} sub=${sub.id}`,
      )
      return
    }

    // Resolve the price → plan id. A subscription can have multiple
    // items; we use the first (our plans are single-line today).
    const priceId = sub.items.data[0]?.price.id
    if (!priceId) {
      this.logger.warn(`Subscription ${sub.id} has no price — skipping`)
      return
    }

    const { data: plan, error: planError } = await client
      .from('subscriptions')
      .select('id')
      .eq('stripe_price_id', priceId)
      .single()

    if (planError || !plan) {
      this.logger.warn(
        `Subscription ${sub.id} uses unknown stripe_price_id=${priceId}`,
      )
      return
    }

    const { error: updateError } = await client
      .from('accounts')
      .update({
        plan_id: plan.id,
        stripe_subscription_id: sub.id,
      })
      .eq('user_id', userId)

    if (updateError) {
      this.logger.error(
        `Failed to update plan for user ${userId}: ${updateError.message}`,
      )
      // Throwing forces Stripe to retry — usually desirable for a
      // DB blip, undesirable for permanent failures. The Stripe
      // dashboard retry policy is exponential backoff over a few
      // days, which is the right ceiling here.
      throw updateError
    }

    this.logger.log(
      `Upserted subscription  user=${userId}  plan=${plan.id}  sub=${sub.id}`,
    )
  }

  /**
   * Subscription terminated — revert the account to free and clear
   * the subscription id. Customer id stays for future upgrades.
   */
  private async handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const client = this.supabaseService.getClient()

    const userIdFromMetadata = sub.metadata?.databerry_user_id ?? null
    let userId: string | null = userIdFromMetadata

    if (!userId) {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      const { data: account } = await client
        .from('accounts')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .single()
      userId = account?.user_id ?? null
    }

    if (!userId) {
      this.logger.warn(`Cancelled subscription ${sub.id} — no matching account`)
      return
    }

    const { error } = await client
      .from('accounts')
      .update({ plan_id: 'free', stripe_subscription_id: null })
      .eq('user_id', userId)

    if (error) {
      this.logger.error(
        `Failed to revert plan on cancel for user ${userId}: ${error.message}`,
      )
      throw error
    }

    this.logger.log(`Reverted to free  user=${userId}  sub=${sub.id}`)
  }
}
