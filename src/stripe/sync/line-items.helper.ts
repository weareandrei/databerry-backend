import type { Logger } from '@nestjs/common'
import type { StripeGetter } from '../views/stripe-api.helpers'
import type {
  StripeChargeRow,
  StripeCheckoutLineRow,
  StripeCheckoutSessionRow,
  StripeInvoiceLineRow,
  StripeInvoicePaymentRow,
  StripeInvoiceRow,
  StripeListPage,
} from './types'

/**
 * One persisted line-item row. `productId` is required — line items without
 * a product reference are skipped (very rare; only happens for ad-hoc Stripe
 * "custom amount" invoice lines that don't reference a Price).
 */
export interface ResolvedLineItem {
  id: string
  product_id: string
  price_id: string | null
  amount: number
  quantity: number | null
}

/**
 * Resolve a charge's product line items.
 *
 * Stripe deprecated the direct `Charge.invoice` / `PaymentIntent.invoice`
 * back-links in newer API versions, so the resolver now tries five paths
 * in order:
 *
 *   1. `charge.invoice` is an inline-expanded Invoice → use it directly.
 *   2. `charge.invoice` is a string ID → fetch
 *      `/v1/invoices/<id>?expand[]=lines.data.price`.
 *   3. `charge.invoice` is null but `charge.payment_intent` exists → look
 *      up the matching `invoice_payment` via
 *      `/v1/invoice_payments?payment[type]=payment_intent
 *      &payment[payment_intent]=<pi>` to get the invoice ID, then fetch
 *      the invoice as in Case 2. **This is the path that recovers from
 *      Stripe's removal of `Charge.invoice`** — without it, every charge
 *      created via `invoices.pay` since the 2024-09-30 API version
 *      records as "unattributed" and never appears in product-filtered
 *      revenue tiles.
 *   4. `charge.payment_intent` exists but no `invoice_payment` matches →
 *      try `/v1/checkout/sessions?payment_intent=<pi>` (Checkout flow,
 *      not subscription/manual-invoice).
 *   5. None of the above → return [] (truly unattributed; charge appears
 *      in unfiltered totals only).
 *
 * Pure data — no DB writes here. Caller handles upsert.
 */
export async function resolveChargeLineItems(
  get: StripeGetter,
  charge: StripeChargeRow,
  logger?: Logger,
): Promise<ResolvedLineItem[]> {
  // Cases 1+2+3 all converge on "we have an invoice ID, fetch its lines".
  // Resolve which case we're in, find the invoice ID, then go fetch.
  let invoiceId: string | null = null
  let source: 'inline' | 'fetched' | 'via-payment' = 'fetched'
  let inlineInvoice: StripeInvoiceRow | null = null

  if (charge.invoice) {
    if (typeof charge.invoice === 'object') {
      inlineInvoice = charge.invoice
      invoiceId = charge.invoice.id
      source = 'inline'
    } else {
      invoiceId = charge.invoice
      source = 'fetched'
    }
  } else if (charge.payment_intent) {
    // Case 3: charge has a PaymentIntent but no invoice link — typical for
    // every invoiced charge in current Stripe API versions. Look up the
    // bridging `invoice_payment`.
    try {
      const payments = (await get('invoice_payments', {
        'payment[type]': 'payment_intent',
        'payment[payment_intent]': charge.payment_intent,
        limit: '1',
      })) as unknown as StripeListPage<StripeInvoicePaymentRow>
      const inpay = payments.data?.[0]
      if (inpay?.invoice) {
        invoiceId = inpay.invoice
        source = 'via-payment'
      }
    } catch (err) {
      logger?.warn(
        `  ⚠ Failed to look up invoice_payment for PI ${charge.payment_intent}: ${String(err)}`,
      )
    }
  }

  if (invoiceId) {
    let invoice: StripeInvoiceRow | null = inlineInvoice
    if (!invoice) {
      try {
        invoice = (await get(`invoices/${invoiceId}`, {
          'expand[]': 'lines.data.price',
        })) as unknown as StripeInvoiceRow
      } catch (err) {
        logger?.warn(`  ⚠ Failed to fetch invoice ${invoiceId}: ${String(err)}`)
        return []
      }
    }

    const rawLines = invoice?.lines?.data ?? []
    const mapped = mapInvoiceLines(rawLines)

    // Detailed trace — `raw=N mapped=M` mismatch usually points at
    // price-not-expanded; raw=0 points at an invoice with no line items.
    logger?.log(
      `    resolveLineItems  charge=${charge.id}  invoice=${invoiceId}  source=${source}  raw=${rawLines.length}  mapped=${mapped.length}`,
    )
    if (rawLines.length > 0 && mapped.length === 0) {
      const sample = rawLines[0]
      logger?.warn(
        `    ⚠ all lines dropped — sample line price=${JSON.stringify(sample.price)}  amount=${sample.amount}`,
      )
    }

    return mapped
  }

  // Case 4: PaymentIntent without an invoice_payment match → Checkout
  // Session lookup (one-time non-subscription Checkout flow).
  if (charge.payment_intent) {
    try {
      const sessions = (await get('checkout/sessions', {
        payment_intent: charge.payment_intent,
        'expand[]': 'data.line_items.data.price',
        limit: '1',
      })) as unknown as StripeListPage<StripeCheckoutSessionRow>

      const session = sessions.data?.[0]
      if (session?.line_items?.data?.length) {
        const mapped = mapCheckoutLines(session.line_items.data)
        logger?.log(
          `    resolveLineItems  charge=${charge.id}  source=checkout-session  raw=${session.line_items.data.length}  mapped=${mapped.length}`,
        )
        return mapped
      }
      logger?.log(
        `    resolveLineItems  charge=${charge.id}  source=checkout-session  no-session-found`,
      )
    } catch (err) {
      logger?.warn(
        `  ⚠ Failed to fetch checkout session for PI ${charge.payment_intent}: ${String(err)}`,
      )
    }
  }

  // Case 5: truly unattributed
  logger?.log(
    `    resolveLineItems  charge=${charge.id}  source=unattributed  pi=${charge.payment_intent ?? '<none>'}`,
  )
  return []
}

function mapInvoiceLines(lines: StripeInvoiceLineRow[]): ResolvedLineItem[] {
  const out: ResolvedLineItem[] = []
  for (const l of lines) {
    // Newer API shape — `pricing.price_details` surfaces price+product
    // inline. This is the only shape Stripe returns on current accounts;
    // we still try the older `l.price` shape afterwards as a fallback so
    // the resolver doesn't break if a webhook on a back-version account
    // hits it.
    const pd = l.pricing?.price_details
    if (pd?.product) {
      out.push({
        id: l.id,
        product_id: pd.product,
        price_id: pd.price ?? null,
        amount: l.amount,
        quantity: l.quantity ?? null,
      })
      continue
    }

    // Older API fallback. `price` may be an expanded object OR a bare
    // string ID (when the caller forgot to expand). Both cases here.
    if (typeof l.price === 'string' || !l.price) continue
    const productId = l.price.product
    if (!productId) continue
    out.push({
      id: l.id,
      product_id: productId,
      price_id: l.price.id ?? null,
      amount: l.amount,
      quantity: l.quantity ?? null,
    })
  }
  return out
}

function mapCheckoutLines(lines: StripeCheckoutLineRow[]): ResolvedLineItem[] {
  const out: ResolvedLineItem[] = []
  for (const l of lines) {
    if (typeof l.price === 'string' || !l.price) continue
    const productId = l.price.product
    if (!productId) continue
    out.push({
      id: l.id,
      product_id: productId,
      price_id: l.price.id ?? null,
      amount: l.amount_total,
      quantity: l.quantity ?? null,
    })
  }
  return out
}
