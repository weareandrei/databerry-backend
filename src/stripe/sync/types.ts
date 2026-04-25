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
