import type { SupabaseService } from '../../supabase/supabase.service'
import type { ResolvedLineItem } from './line-items.helper'
import {
  computeMonthlyAmountCents,
  subscriptionItemsForRow,
} from './mrr.helper'
import type {
  StripeAccountRow,
  StripeChargeRow,
  StripeCustomerRow,
  StripeProductRow,
  StripeSubscriptionRow,
} from './types'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * Upsert a stripe_accounts row. Does NOT touch backfill_status / last_synced_at —
 * those are managed by the backfill / reconcile services to avoid clobbering
 * their bookkeeping when this is called from the webhook fast-path.
 */
export async function upsertAccount(
  client: Client,
  account: StripeAccountRow,
): Promise<void> {
  const displayName = account.business_profile?.name ?? null

  const { error } = await client
    .from('stripe_accounts')
    .upsert(
      {
        id: account.id,
        display_name: displayName,
        livemode: account.livemode,
      },
      { onConflict: 'id', ignoreDuplicates: false },
    )

  if (error) throw new Error(`stripe_accounts upsert: ${error.message}`)
}

/**
 * Bulk upsert customers for a given account. Empty array is a no-op.
 * Filters out Stripe's "deleted: true" stub customers — we don't surface
 * them in the top-customers tile and persisting them would break the
 * NOT-NULL `created` constraint anyway (Stripe doesn't include the field
 * on stubs).
 */
export async function upsertCustomers(
  client: Client,
  stripeAccountId: string,
  customers: StripeCustomerRow[],
): Promise<void> {
  if (customers.length === 0) return

  const rows = customers
    .filter(c => !c.deleted)
    .map(c => ({
      id: c.id,
      stripe_account_id: stripeAccountId,
      name: c.name ?? null,
      email: c.email ?? null,
      created: new Date(c.created * 1000).toISOString(),
    }))

  if (rows.length === 0) return

  const { error } = await client
    .from('stripe_customers')
    .upsert(rows, { onConflict: 'id' })

  if (error) throw new Error(`stripe_customers upsert: ${error.message}`)
}

/**
 * Bulk upsert subscriptions. Computes `monthly_amount_cents` and the
 * persisted JSONB items shape inline so the read-side never has to know
 * about Stripe's price expansion.
 */
export async function upsertSubscriptions(
  client: Client,
  stripeAccountId: string,
  subs: StripeSubscriptionRow[],
): Promise<void> {
  if (subs.length === 0) return

  const rows = subs.map(s => {
    const monthly = computeMonthlyAmountCents(s)
    const items = subscriptionItemsForRow(s)
    return {
      id: s.id,
      stripe_account_id: stripeAccountId,
      customer_id: s.customer,
      status: s.status,
      currency: s.currency,
      monthly_amount_cents: monthly,
      created: new Date(s.created * 1000).toISOString(),
      canceled_at: s.canceled_at
        ? new Date(s.canceled_at * 1000).toISOString()
        : null,
      current_period_end: s.current_period_end
        ? new Date(s.current_period_end * 1000).toISOString()
        : null,
      // Postgres' jsonb column accepts JS arrays directly via PostgREST.
      items,
    }
  })

  const { error } = await client
    .from('stripe_subscriptions')
    .upsert(rows, { onConflict: 'id' })

  if (error) throw new Error(`stripe_subscriptions upsert: ${error.message}`)
}

/** Bulk upsert products for a given account. Empty array is a no-op. */
export async function upsertProducts(
  client: Client,
  stripeAccountId: string,
  products: StripeProductRow[],
): Promise<void> {
  if (products.length === 0) return

  const rows = products.map(p => ({
    stripe_account_id: stripeAccountId,
    id: p.id,
    name: p.name,
    active: p.active,
  }))

  const { error } = await client
    .from('stripe_products')
    .upsert(rows, { onConflict: 'stripe_account_id,id' })

  if (error) throw new Error(`stripe_products upsert: ${error.message}`)
}

/** Upsert a single charge. Idempotent on `id`. */
export async function upsertCharge(
  client: Client,
  stripeAccountId: string,
  charge: StripeChargeRow,
): Promise<void> {
  const { error } = await client
    .from('stripe_charges')
    .upsert(
      {
        id: charge.id,
        stripe_account_id: stripeAccountId,
        amount: charge.amount,
        amount_refunded: charge.amount_refunded ?? 0,
        currency: charge.currency,
        status: charge.status,
        created: new Date(charge.created * 1000).toISOString(),
        payment_intent_id: charge.payment_intent,
        invoice_id:
          typeof charge.invoice === 'string'
            ? charge.invoice
            : charge.invoice?.id ?? null,
        customer_id: charge.customer,
      },
      { onConflict: 'id' },
    )

  if (error) throw new Error(`stripe_charges upsert: ${error.message}`)
}

/**
 * Replace the line items for a charge. Delete-then-insert because invoice
 * lines can be edited (rare but possible) and we want the latest snapshot to
 * win — partial overlapping inserts via upsert wouldn't remove stale rows.
 */
export async function replaceLineItems(
  client: Client,
  chargeId: string,
  stripeAccountId: string,
  lineItems: ResolvedLineItem[],
): Promise<void> {
  // Always clear existing rows first; if lineItems is empty, the charge ends
  // up with no attribution rows (= "unattributed"), which is the desired state.
  const { error: delErr } = await client
    .from('stripe_line_items')
    .delete()
    .eq('charge_id', chargeId)

  if (delErr) throw new Error(`stripe_line_items delete: ${delErr.message}`)

  if (lineItems.length === 0) return

  const rows = lineItems.map(l => ({
    id: l.id,
    charge_id: chargeId,
    stripe_account_id: stripeAccountId,
    product_id: l.product_id,
    price_id: l.price_id,
    amount: l.amount,
    quantity: l.quantity,
  }))

  const { error: insErr } = await client
    .from('stripe_line_items')
    .insert(rows)

  if (insErr) throw new Error(`stripe_line_items insert: ${insErr.message}`)
}

/**
 * Update `backfill_status` (and optionally error/error-message).
 *
 * `backfill_started_at` bookkeeping piggybacks on this:
 *   - `'in_progress'` stamps a fresh `NOW()` so stale-run detection can
 *     measure how long the run has been alive.
 *   - terminal statuses (`'complete'` / `'error'`) clear it — the row is no
 *     longer "claimed" by an in-flight worker.
 *   - `'pending'` also clears it (used by retry).
 */
export async function setBackfillStatus(
  client: Client,
  stripeAccountId: string,
  status: 'pending' | 'in_progress' | 'complete' | 'error',
  errorMessage?: string,
): Promise<void> {
  const update: Record<string, unknown> = { backfill_status: status }
  if (status === 'error') {
    update.backfill_error = errorMessage ?? null
    update.backfill_started_at = null
  }
  if (status === 'complete') {
    update.backfill_error = null
    update.last_synced_at = new Date().toISOString()
    update.backfill_started_at = null
  }
  if (status === 'pending') {
    update.backfill_started_at = null
  }
  if (status === 'in_progress') {
    update.backfill_started_at = new Date().toISOString()
  }

  const { error } = await client
    .from('stripe_accounts')
    .update(update)
    .eq('id', stripeAccountId)

  if (error) throw new Error(`stripe_accounts status update: ${error.message}`)
}

/**
 * Sets `last_synced_at = NOW()` (not status — used by reconcile).
 */
export async function bumpLastSyncedAt(
  client: Client,
  stripeAccountId: string,
): Promise<void> {
  const { error } = await client
    .from('stripe_accounts')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', stripeAccountId)

  if (error) throw new Error(`stripe_accounts last_synced_at: ${error.message}`)
}
