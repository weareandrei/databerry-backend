import type { Logger } from '@nestjs/common'
import type { SupabaseService } from '../../supabase/supabase.service'
import type { StripeGetter } from '../views/stripe-api.helpers'
import { resolveChargeLineItems } from './line-items.helper'
import {
  replaceLineItems,
  upsertCharge,
  upsertCustomers,
  upsertProducts,
  upsertSubscriptions,
} from './persist.helper'
import type {
  StripeChargeRow,
  StripeCustomerRow,
  StripeListPage,
  StripeProductRow,
  StripeSubscriptionRow,
} from './types'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * Fetch + upsert any customers referenced by recent charges that aren't
 * already in `stripe_customers`. The bulk `customers.list()` endpoint
 * silently omits customers attached to deleted test clocks (and likely
 * other lifecycle states), so charges can reference customer IDs that
 * the wide-sweep pass misses. Direct retrieval works regardless.
 *
 * Idempotent. No-op when every referenced customer is already in DB
 * (the typical steady-state case after the first run).
 */
async function fillMissingCustomers(
  client: Client,
  stripeAccountId: string,
  get: StripeGetter,
  ids: string[],
  logger?: Logger,
): Promise<number> {
  if (ids.length === 0) return 0

  const { data: existing, error } = await client
    .from('stripe_customers')
    .select('id')
    .eq('stripe_account_id', stripeAccountId)
    .in('id', ids)
  if (error) {
    logger?.warn(
      `    ⚠ fillMissingCustomers existence check failed: ${error.message}`,
    )
    return 0
  }
  const present = new Set((existing ?? []).map(r => r.id as string))
  const missing = ids.filter(id => !present.has(id))
  if (missing.length === 0) return 0

  logger?.log(
    `    fillMissingCustomers  account=${stripeAccountId}  referenced=${ids.length}  missing=${missing.length}`,
  )

  // Per-id retrieve. We deliberately don't parallelise — the 1× per-charge
  // overhead is bounded (typical accounts have far fewer customers than
  // charges, and the typical steady-state case has `missing.length === 0`).
  // Sequential keeps the Stripe rate-limit profile simple.
  const fetched: StripeCustomerRow[] = []
  for (const id of missing) {
    try {
      const c = (await get(`customers/${id}`)) as unknown as
        StripeCustomerRow & { deleted?: boolean }
      // Stripe returns `{ id, deleted: true }` for tombstoned customers —
      // `upsertCustomers` already filters those by `c.deleted`, but skipping
      // here too saves the round-trip of pushing them through the persist
      // layer just to be filtered.
      if (c.deleted) continue
      fetched.push(c)
    } catch (err) {
      logger?.warn(
        `    ⚠ customer fetch ${id} failed: ${String(err)}`,
      )
    }
  }

  await upsertCustomers(client, stripeAccountId, fetched)
  return fetched.length
}

/**
 * Pull every charge in [createdGte, createdLt) for a Stripe account, resolve
 * line items, and persist. Used by backfill (90 days), reconcile (last 7d),
 * reconnect gap-fills, and live-on-mount syncs. Idempotent — repeat runs
 * over the same range produce the same end state.
 *
 * Pagination: 100 charges/page. **No `expand[]`** on the list call — we
 * deliberately leave `charge.invoice` as a bare string ID and let
 * `resolveChargeLineItems` round-trip per-charge to fetch the invoice
 * with the proper `expand[]=lines.data.price`. This costs one extra
 * Stripe call per invoiced charge but it's the only way to get prices
 * as objects — `data.invoice.lines.data.price` is 5 levels deep,
 * exceeding Stripe's 4-level expansion cap.
 *
 * History: an earlier optimization tried `expand[]=data.invoice` to
 * inline the invoice and skip a round-trip. That left
 * `lines.data[i].price` as a string ID (since deeper expansion isn't
 * allowed), and `mapInvoiceLines` silently dropped every line. Visible
 * symptom: MRR worked (subs table, no line-item join) but Gross Volume /
 * Top Customers / Total Gross Revenue all read $0 (line-item-joined).
 * Don't add the expansion back without a different shape for resolution.
 *
 * For charges with no invoice (raw PaymentIntents), falls back to a
 * Checkout Session lookup (one extra call per such charge — rare).
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

  // Collected as we walk the charges so that, after persisting them all,
  // we can ensure every customer they reference has a row in
  // `stripe_customers`. Stripe's bulk `customers.list` endpoint omits
  // customers attached to deleted test clocks (and probably other states),
  // so without this gap-fill, charges can reference customer IDs the
  // top-customers tile can't resolve to a name. See `fillMissingCustomers`.
  const referencedCustomerIds = new Set<string>()

  while (hasMore) {
    const params: Record<string, string> = {
      'created[gte]': String(createdGte),
      'created[lt]': String(createdLt),
      limit: '100',
    }
    if (startingAfter) params['starting_after'] = startingAfter

    const page = (await get('charges', params)) as unknown as StripeListPage<StripeChargeRow>
    const charges = page.data ?? []

    for (const charge of charges) {
      // Persist charge row first (FK target for line items).
      await upsertCharge(client, stripeAccountId, charge)
      if (charge.customer) referencedCustomerIds.add(charge.customer)

      // Only succeeded charges contribute to revenue tiles, but we still
      // resolve line items for refunded charges (so future refund support
      // has the attribution it needs).
      const lineItems = await resolveChargeLineItems(get, charge, logger)

      // Critical defence against "reconcile silently wipes everything".
      // `replaceLineItems` is DELETE-then-INSERT; if the resolver came up
      // empty (because the resolver code is stale, or invoice_payments
      // hit a transient error, or any number of reasons we may not yet
      // know), we'd nuke the existing rows and replace them with nothing.
      // That's how the team woke up to an empty `stripe_line_items` table
      // after a deploy lag: an old version of this code returned `[]` for
      // every charge, and the nightly reconcile dutifully deleted-then-
      // inserted-nothing for all of them.
      //
      // Rule: only call `replaceLineItems` when we actually resolved
      // something to replace WITH. Empty results are treated as "couldn't
      // resolve, leave existing alone". The trade-off — if a charge's
      // invoice legitimately loses all its line items in Stripe, our DB
      // keeps stale rows — is overwhelmingly preferable to wiping data.
      // A separate manual `repair-line-items.js` exists for the rare
      // genuine-empty case.
      if (lineItems.length > 0) {
        try {
          await replaceLineItems(client, charge.id, stripeAccountId, lineItems)
          logger?.log(
            `    replaceLineItems  charge=${charge.id}  inserted=${lineItems.length}`,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger?.error(
            `    ✗ replaceLineItems FAILED  charge=${charge.id}  msg="${msg}"`,
          )
          throw err
        }
      } else {
        logger?.warn(
          `    replaceLineItems SKIP  charge=${charge.id}  resolver returned 0 — existing rows preserved`,
        )
      }

      processed++
    }

    hasMore = page.has_more
    if (hasMore && charges.length > 0) {
      startingAfter = charges[charges.length - 1].id
    }
  }

  // Fill in any customer rows the bulk customer sync would have missed.
  // No-op when every referenced customer is already in DB (the steady-
  // state case). The cost is bounded: 1 existence check + N retrieves
  // where N == count of newly-referenced customers in this sync window.
  await fillMissingCustomers(
    client,
    stripeAccountId,
    get,
    Array.from(referencedCustomerIds),
    logger,
  )

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

/**
 * List every customer (active + deleted-stub) for a Stripe account and upsert
 * into `stripe_customers`. Pagination: 100/page. Used by backfill so the
 * "top customers" tile can resolve names; reconcile skips this since the
 * customer set rarely changes in ways that affect a dashboard tile.
 *
 * Stripe returns deleted-customer stubs (`{ id, deleted: true }`) when the
 * underlying customer was removed. The persist layer drops those rows.
 */
export async function syncCustomers(
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

    const page = (await get('customers', params)) as unknown as StripeListPage<StripeCustomerRow>
    const customers = page.data ?? []

    logger?.log(
      `    syncCustomers  account=${stripeAccountId}  page=${pageNum}  items=${customers.length}  has_more=${page.has_more}`,
    )

    if (customers.length > 0) {
      await upsertCustomers(client, stripeAccountId, customers)
      processed += customers.length
    }

    hasMore = page.has_more
    if (hasMore && customers.length > 0) {
      startingAfter = customers[customers.length - 1].id
    }
  }

  return processed
}

/**
 * List every subscription (active + canceled + everything in between) for a
 * Stripe account, compute monthly MRR contribution per row, and upsert.
 *
 * `status=all` is critical: Stripe's `/v1/subscriptions` defaults to
 * active-only, but we need canceled rows for the churn-rate tile and to
 * catch cancellations between webhook deliveries during nightly reconcile.
 *
 * `expand[]=data.items.data.price` inlines per-item prices (with
 * `unit_amount` and `recurring.interval`) — without this we'd need a
 * per-item round-trip to /v1/prices, multiplying the page cost by N.
 */
export async function syncSubscriptions(
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
    const params: Record<string, string> = {
      status: 'all',
      'expand[]': 'data.items.data.price',
      limit: '100',
    }
    if (startingAfter) params['starting_after'] = startingAfter

    const page = (await get('subscriptions', params)) as unknown as StripeListPage<StripeSubscriptionRow>
    const subs = page.data ?? []

    logger?.log(
      `    syncSubscriptions  account=${stripeAccountId}  page=${pageNum}  items=${subs.length}  has_more=${page.has_more}`,
    )

    if (subs.length > 0) {
      await upsertSubscriptions(client, stripeAccountId, subs)
      processed += subs.length
    }

    hasMore = page.has_more
    if (hasMore && subs.length > 0) {
      startingAfter = subs[subs.length - 1].id
    }
  }

  return processed
}
