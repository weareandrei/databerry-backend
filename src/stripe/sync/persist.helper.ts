import type { SupabaseService } from '../../supabase/supabase.service'
import type { ResolvedLineItem } from './line-items.helper'
import type {
  StripeAccountRow,
  StripeChargeRow,
  StripeProductRow,
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

/** Update only the `backfill_status` (and optionally error/error-message). */
export async function setBackfillStatus(
  client: Client,
  stripeAccountId: string,
  status: 'pending' | 'in_progress' | 'complete' | 'error',
  errorMessage?: string,
): Promise<void> {
  const update: Record<string, unknown> = { backfill_status: status }
  if (status === 'error') update.backfill_error = errorMessage ?? null
  if (status === 'complete') {
    update.backfill_error = null
    update.last_synced_at = new Date().toISOString()
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
