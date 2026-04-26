import type { Logger } from '@nestjs/common'
import type { SupabaseService } from '../../supabase/supabase.service'
import type { StripeGetter } from '../views/stripe-api.helpers'
import { resolveChargeLineItems } from './line-items.helper'
import {
  replaceLineItems,
  upsertCharge,
  upsertProducts,
} from './persist.helper'
import type {
  StripeChargeRow,
  StripeListPage,
  StripeProductRow,
} from './types'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * Pull every charge in [createdGte, createdLt) for a Stripe account, resolve
 * line items, and persist. Used by both backfill (90 days) and reconcile
 * (last 48h). Idempotent — repeat runs over the same range produce the same
 * end state.
 *
 * Pagination: 100 charges/page, `expand[]=data.invoice` to inline invoice
 * objects (avoids per-charge invoice round-trips). For charges with no
 * invoice, falls back to a Checkout Session lookup (one extra call).
 *
 * Returns the count of charges processed for logging.
 */
export async function syncCharges(
  client: Client,
  stripeAccountId: string,
  get: StripeGetter,
  createdGte: number,
  createdLt: number,
  logger?: Logger,
): Promise<number> {
  let processed = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params: Record<string, string> = {
      'created[gte]': String(createdGte),
      'created[lt]': String(createdLt),
      'expand[]': 'data.invoice',
      limit: '100',
    }
    if (startingAfter) params['starting_after'] = startingAfter

    const page = (await get('charges', params)) as unknown as StripeListPage<StripeChargeRow>
    const charges = page.data ?? []

    for (const charge of charges) {
      // Persist charge row first (FK target for line items).
      await upsertCharge(client, stripeAccountId, charge)

      // Only succeeded charges contribute to revenue tiles, but we still
      // resolve line items for refunded charges (so future refund support
      // has the attribution it needs).
      const lineItems = await resolveChargeLineItems(get, charge, logger)
      await replaceLineItems(client, charge.id, stripeAccountId, lineItems)

      processed++
    }

    hasMore = page.has_more
    if (hasMore && charges.length > 0) {
      startingAfter = charges[charges.length - 1].id
    }
  }

  return processed
}

/**
 * List every product (active *and* archived) for a Stripe account and upsert
 * into `stripe_products`. Pagination: 100/page. Used by backfill so the
 * picker has data immediately; reconcile skips this since products rarely
 * change.
 *
 * We deliberately fetch archived products too: the picker labels them
 * "· archived" but the user may want to retroactively attribute past charges
 * to a product they've since archived. Filtering them out at fetch time
 * silently broke that case.
 */
export async function syncProducts(
  client: Client,
  stripeAccountId: string,
  get: StripeGetter,
  logger?: Logger,
): Promise<number> {
  let processed = 0
  let hasMore = true
  let startingAfter: string | undefined
  let pageNum = 0

  while (hasMore) {
    pageNum++
    const params: Record<string, string> = { limit: '100' }
    if (startingAfter) params['starting_after'] = startingAfter

    const page = (await get('products', params)) as unknown as StripeListPage<StripeProductRow>
    const products = page.data ?? []

    logger?.log(
      `    syncProducts  account=${stripeAccountId}  page=${pageNum}  items=${products.length}  has_more=${page.has_more}`,
    )

    if (products.length > 0) {
      await upsertProducts(client, stripeAccountId, products)
      processed += products.length
    }

    hasMore = page.has_more
    if (hasMore && products.length > 0) {
      startingAfter = products[products.length - 1].id
    }
  }

  if (processed === 0) {
    logger?.warn(
      `    syncProducts  account=${stripeAccountId}  → 0 products fetched. ` +
        `Either the account has none, or the API key lacks "Products → Read" scope.`,
    )
  }

  return processed
}
