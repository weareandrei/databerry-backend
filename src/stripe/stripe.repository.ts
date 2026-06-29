import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class StripeRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  upsertAccount(row: {
    id: string
    display_name: string | null
    livemode: boolean
  }) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .upsert(row, { onConflict: 'id', ignoreDuplicates: false })
  }

  updateAccount(id: string, update: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .update(update)
      .eq('id', id)
  }

  findLastSyncedAt(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('last_synced_at')
      .eq('id', id)
      .maybeSingle()
  }

  findBackfillStatusAndStartedAt(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('backfill_status, backfill_started_at')
      .eq('id', id)
      .maybeSingle()
  }

  findBackfillStatusAndLastSyncedAt(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('backfill_status, last_synced_at')
      .eq('id', id)
      .maybeSingle()
  }

  findBackfilledThrough(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('backfilled_through')
      .eq('id', id)
      .maybeSingle()
  }

  findBackfillInfo(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('backfill_status, backfill_error')
      .eq('id', id)
      .maybeSingle()
  }

  findAccountStatus(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('id, backfill_status, backfilled_through, last_synced_at, backfill_error')
      .eq('id', id)
      .maybeSingle()
  }

  findIdAndBackfillStatus(id: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('id, backfill_status')
      .eq('id', id)
      .maybeSingle()
  }

  listCompleteAccountIds() {
    return this.supabaseService
      .getClient()
      .from('stripe_accounts')
      .select('id')
      .eq('backfill_status', 'complete')
  }

  upsertCustomers(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_customers')
      .upsert(rows, { onConflict: 'id' })
  }

  findCustomerIdsByAccount(stripeAccountId: string, ids: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_customers')
      .select('id')
      .eq('stripe_account_id', stripeAccountId)
      .in('id', ids)
  }

  findCustomersByIds(ids: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_customers')
      .select('id, name, email, address_country, address_city')
      .in('id', ids)
  }

  upsertSubscriptions(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_subscriptions')
      .upsert(rows, { onConflict: 'id' })
  }

  findActiveSubscriptions(stripeAccountId: string, statuses: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_subscriptions')
      .select('id, monthly_amount_cents, items')
      .eq('stripe_account_id', stripeAccountId)
      .in('status', statuses)
  }

  countActiveSubscriptions(stripeAccountId: string, statuses: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('stripe_account_id', stripeAccountId)
      .in('status', statuses)
  }

  countCanceledSubscriptionsSince(stripeAccountId: string, sinceISO: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('stripe_account_id', stripeAccountId)
      .gte('canceled_at', sinceISO)
  }

  upsertProducts(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_products')
      .upsert(rows, { onConflict: 'stripe_account_id,id' })
  }

  findProductsByAccount(stripeAccountId: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_products')
      .select('id, name, active')
      .eq('stripe_account_id', stripeAccountId)
      .order('active', { ascending: false })
      .order('name', { ascending: true })
  }

  findProductIdsByAccount(stripeAccountId: string, ids: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_products')
      .select('id')
      .eq('stripe_account_id', stripeAccountId)
      .in('id', ids)
  }

  upsertCharge(row: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('stripe_charges')
      .upsert(row, { onConflict: 'id' })
  }

  findSucceededChargesInRange(
    stripeAccountId: string,
    fromISO: string,
    toExclusiveISO: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('stripe_charges')
      .select('amount, created')
      .eq('stripe_account_id', stripeAccountId)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)
  }

  findSucceededChargesWithCustomerInRange(
    stripeAccountId: string,
    fromISO: string,
    toExclusiveISO: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('stripe_charges')
      .select('amount, customer_id')
      .eq('stripe_account_id', stripeAccountId)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)
  }

  findSucceededChargesByIdsInRange(
    chargeIds: string[],
    fromISO: string,
    toExclusiveISO: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('stripe_charges')
      .select('id, created')
      .in('id', chargeIds)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)
  }

  findSucceededChargesWithCustomerByIdsInRange(
    chargeIds: string[],
    fromISO: string,
    toExclusiveISO: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('stripe_charges')
      .select('id, customer_id')
      .in('id', chargeIds)
      .eq('status', 'succeeded')
      .gte('created', fromISO)
      .lt('created', toExclusiveISO)
  }

  findLineItemsByAccountAndProducts(stripeAccountId: string, productIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_line_items')
      .select('charge_id, amount')
      .eq('stripe_account_id', stripeAccountId)
      .in('product_id', productIds)
  }

  deleteLineItemsByChargeId(chargeId: string) {
    return this.supabaseService
      .getClient()
      .from('stripe_line_items')
      .delete()
      .eq('charge_id', chargeId)
  }

  insertLineItems(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('stripe_line_items')
      .insert(rows)
  }
}
