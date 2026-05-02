// Stripe API row shapes we use during backfill / webhook handling. We keep
// these locally typed (vs. importing the full `Stripe.Charge` from the
// official SDK) because:
//  - `makeStripeGetter` returns plain JSON, no SDK objects;
//  - we only persist a handful of fields, so a narrow shape avoids drift if
//    Stripe adds new optional properties we don't care about.

export interface StripeAccountRow {
  id: string
  business_profile?: { name?: string | null } | null
  livemode: boolean
}

export interface StripeProductRow {
  id: string
  name: string
  active: boolean
}

export interface StripePriceRow {
  id: string
  product?: string | null
}

/**
 * Invoice line. Stripe's response shape changed in newer API versions:
 *
 * **Newer (current)**: line items don't carry `price` directly. Instead
 * the `pricing.price_details` block surfaces both the Price ID and the
 * Product ID inline — no `expand[]` needed:
 *   ```
 *   line.pricing.price_details.product = 'prod_xxx'
 *   line.pricing.price_details.price   = 'price_xxx'
 *   ```
 *
 * **Older**: `line.price` was either an expanded object (with
 * `lines.data.price` expansion) or a bare string ID.
 *
 * `mapInvoiceLines` reads from whichever is populated. Carrying both in
 * the type means a mixed account (e.g. some webhook payloads on an
 * older API version + sync calls on a newer one) doesn't surprise the
 * resolver.
 */
export interface StripeInvoiceLineRow {
  id: string
  amount: number
  quantity: number | null
  /** Newer Stripe API shape — Price/Product surfaced inline, no expand needed. */
  pricing?: {
    price_details?: {
      price?: string | null
      product?: string | null
    } | null
  } | null
  /** Older API shape — expanded Price object or bare string ID. */
  price?: { id: string; product?: string | null } | string | null
}

export interface StripeInvoiceRow {
  id: string
  lines?: { data: StripeInvoiceLineRow[] } | null
}

/** Checkout Session line as returned by `expand[]=line_items` on the session.
 *  Same string-vs-object caveat on `price` as `StripeInvoiceLineRow`. */
export interface StripeCheckoutLineRow {
  id: string
  amount_total: number
  quantity: number | null
  price?: { id: string; product?: string | null } | string | null
}

export interface StripeCheckoutSessionRow {
  id: string
  payment_intent: string | null
  line_items?: { data: StripeCheckoutLineRow[] } | null
}

/**
 * Charge as returned by `/v1/charges` (no expansion). `invoice` is a
 * string ID — `resolveChargeLineItems` does the per-charge invoice
 * fetch with the proper `expand[]=lines.data.price`. The list call
 * intentionally doesn't inline-expand the invoice because
 * `data.invoice.lines.data.price` is 5 levels deep, exceeding Stripe's
 * 4-level cap.
 *
 * Webhook payloads also surface `invoice` as a string. The
 * `StripeInvoiceRow | ...` arm of the union remains for forward
 * compatibility with callers that pass an inline-expanded charge.
 */
export interface StripeChargeRow {
  id: string
  amount: number
  amount_refunded: number
  currency: string
  status: string
  created: number
  payment_intent: string | null
  invoice: StripeInvoiceRow | string | null
  customer: string | null
}

export interface StripeListPage<T> {
  object: 'list'
  data: T[]
  has_more: boolean
}

/**
 * `invoice_payment` — the bridge resource Stripe introduced after they
 * removed `Charge.invoice` and `PaymentIntent.invoice` direct back-links.
 * Listed via `/v1/invoice_payments?payment[type]=payment_intent
 * &payment[payment_intent]=pi_xxx`, this gives us the invoice ID for a
 * charge that paid one. Without this lookup, charges from `invoices.pay`
 * have no path back to their invoice in current Stripe API versions.
 */
export interface StripeInvoicePaymentRow {
  id: string
  invoice: string
  status: string
  payment: {
    type: 'payment_intent' | string
    payment_intent?: string
  }
}

/**
 * Customer as returned by `/v1/customers`. We persist identity fields plus
 * the country/city from `address` so the "top customers" tile can show
 * "Bucharest, RO" under the email. Street-address pieces (line1/line2/
 * postal_code) are deliberately not persisted — PII we don't need and
 * never display.
 *
 * Stripe occasionally returns deleted customer stubs (`{ id, deleted: true }`);
 * the sync layer filters those before upsert.
 */
export interface StripeCustomerRow {
  id: string
  name?: string | null
  email?: string | null
  /** Stripe's billing address. Any field can be null/missing depending on
   *  what the customer provided at checkout / portal time. */
  address?: {
    country?: string | null
    city?: string | null
  } | null
  created: number // unix seconds
  deleted?: boolean
}

/** Recurring price metadata embedded under `subscription.items.data[].price`. */
export interface StripeRecurringRow {
  interval: 'day' | 'week' | 'month' | 'year'
  interval_count: number
}

export interface StripeSubscriptionPriceRow {
  id: string
  product?: string | null
  unit_amount?: number | null
  currency?: string | null
  recurring?: StripeRecurringRow | null
}

/** Subscription item as returned by `expand[]=data.items.data.price`. */
export interface StripeSubscriptionItemRow {
  id: string
  quantity?: number | null
  price?: StripeSubscriptionPriceRow | null
}

/**
 * Subscription row as returned by `/v1/subscriptions?status=all` with
 * `expand[]=data.items.data.price`.
 *
 * Stripe surfaces `current_period_end` and `canceled_at` as unix seconds (or
 * nullable for active subs). We persist both as TIMESTAMPTZ; conversion lives
 * at the persist layer.
 */
export interface StripeSubscriptionRow {
  id: string
  customer: string | null
  status: string
  currency: string
  created: number
  canceled_at: number | null
  current_period_end: number | null
  items?: { data: StripeSubscriptionItemRow[] } | null
}
