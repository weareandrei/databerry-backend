import type { Logger } from '@nestjs/common'
import type { StripeGetter } from '../views/stripe-api.helpers'
import type {
  StripeChargeRow,
  StripeCheckoutLineRow,
  StripeCheckoutSessionRow,
  StripeInvoiceLineRow,
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
 *   1. If `charge.invoice` was expanded inline → use Invoice.lines directly.
 *   2. Else if invoice is a string ID → fetch `/v1/invoices/<id>?expand[]=lines.data.price`.
 *   3. Else if `charge.payment_intent` exists → look up the matching Checkout
 *      Session via `/v1/checkout/sessions?payment_intent=<pi>` and read its
 *      line_items (with `expand[]=data.line_items.data.price`).
 *   4. Else → return [] (charge stands alone, will appear in totals only).
 *
 * Pure data — no DB writes here. Caller handles upsert.
 */
export async function resolveChargeLineItems(
  get: StripeGetter,
  charge: StripeChargeRow,
  logger?: Logger,
): Promise<ResolvedLineItem[]> {
  // Case 1+2: invoice path (subscription or invoiced one-off)
  if (charge.invoice) {
    let invoice: StripeInvoiceRow | null = null

    if (typeof charge.invoice === 'object') {
      invoice = charge.invoice
    } else {
      try {
        invoice = (await get(`invoices/${charge.invoice}`, {
          'expand[]': 'lines.data.price',
        })) as unknown as StripeInvoiceRow
      } catch (err) {
        logger?.warn(`  ⚠ Failed to fetch invoice ${charge.invoice}: ${String(err)}`)
        return []
      }
    }

    return mapInvoiceLines(invoice?.lines?.data ?? [])
  }

  // Case 3: PaymentIntent → Checkout Session lookup
  if (charge.payment_intent) {
    try {
      const sessions = (await get('checkout/sessions', {
        payment_intent: charge.payment_intent,
        'expand[]': 'data.line_items.data.price',
        limit: '1',
      })) as unknown as StripeListPage<StripeCheckoutSessionRow>

      const session = sessions.data?.[0]
      if (session?.line_items?.data?.length) {
        return mapCheckoutLines(session.line_items.data)
      }
    } catch (err) {
      logger?.warn(
        `  ⚠ Failed to fetch checkout session for PI ${charge.payment_intent}: ${String(err)}`,
      )
    }
  }

  // Case 4: unattributed — return empty list, caller treats this as "no line items"
  return []
}

function mapInvoiceLines(lines: StripeInvoiceLineRow[]): ResolvedLineItem[] {
  const out: ResolvedLineItem[] = []
  for (const l of lines) {
    const productId = l.price?.product
    if (!productId) continue
    out.push({
      id: l.id,
      product_id: productId,
      price_id: l.price?.id ?? null,
      amount: l.amount,
      quantity: l.quantity ?? null,
    })
  }
  return out
}

function mapCheckoutLines(lines: StripeCheckoutLineRow[]): ResolvedLineItem[] {
  const out: ResolvedLineItem[] = []
  for (const l of lines) {
    const productId = l.price?.product
    if (!productId) continue
    out.push({
      id: l.id,
      product_id: productId,
      price_id: l.price?.id ?? null,
      amount: l.amount_total,
      quantity: l.quantity ?? null,
    })
  }
  return out
}
