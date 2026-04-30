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

/** Invoice line as returned by `expand[]=lines` on the invoice or charge. */
export interface StripeInvoiceLineRow {
  id: string
  amount: number
  quantity: number | null
  price?: { id: string; product?: string | null } | null
}

export interface StripeInvoiceRow {
  id: string
  lines?: { data: StripeInvoiceLineRow[] } | null
}

/** Checkout Session line as returned by `expand[]=line_items` on the session. */
export interface StripeCheckoutLineRow {
  id: string
  amount_total: number
  quantity: number | null
  price?: { id: string; product?: string | null } | null
}

export interface StripeCheckoutSessionRow {
  id: string
  payment_intent: string | null
  line_items?: { data: StripeCheckoutLineRow[] } | null
}

/** Charge as returned by `expand[]=data.invoice` on the list. */
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
 * Customer as returned by `/v1/customers`. We only persist identity fields —
 * the "top customers" tile shows name/email and a revenue figure, nothing
 * billing-internal. Stripe occasionally returns deleted customer stubs
 * (`{ id, deleted: true }`); the sync layer filters those before upsert.
 */
export interface StripeCustomerRow {
  id: string
  name?: string | null
  email?: string | null
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
