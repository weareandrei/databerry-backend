import { Logger } from '@nestjs/common'
import type { SupabaseService } from '../../../supabase/supabase.service'

export async function handlePaymentSucceeded(
  amountCents: number,
  stripeAccountId: string,
  client: ReturnType<SupabaseService['getClient']>,
  logger: Logger,
): Promise<void> {
  // Find connection by stripe_account_id
  const { data: stripeConn, error: connError } = await client
    .from('connections_stripe')
    .select('connection_id')
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()

  if (connError || !stripeConn) {
    logger.warn(`  ⚠ No connection found for stripe_account_id: ${stripeAccountId}`)
    return
  }

  // Find daily_revenue views for this connection
  const { data: views, error: viewsError } = await client
    .from('views')
    .select('id')
    .eq('connection_id', stripeConn.connection_id)
    .eq('type', 'daily_revenue')

  if (viewsError || !views || views.length === 0) {
    logger.log('  → No daily_revenue views found for this connection')
    return
  }

  logger.log(`  → matched ${views.length} daily_revenue view(s), amount: ${amountCents} cents`)

  for (const view of views as { id: string }[]) {
    await addToDailyRevenue(view.id, amountCents, client, logger)
  }
}

async function addToDailyRevenue(
  viewId: string,
  amountCents: number,
  client: ReturnType<SupabaseService['getClient']>,
  logger: Logger,
): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  const { data: existing } = await client
    .from('views_values')
    .select('id, value')
    .eq('view_id', viewId)
    .eq('created_at', today)
    .maybeSingle()

  if (existing) {
    const newValue = (parseInt(existing.value as string, 10) || 0) + amountCents
    const { error } = await client
      .from('views_values')
      .update({ value: String(newValue), updated_at: new Date().toISOString() })
      .eq('id', existing.id)

    if (error) {
      logger.error(`  ✗ Failed to update daily_revenue\n  ${error.message}`)
      return
    }
    logger.log(`  ✓ daily_revenue updated → ${newValue} cents`)
  } else {
    const { error } = await client
      .from('views_values')
      .insert({ view_id: viewId, value: String(amountCents), created_at: today })

    if (error) {
      logger.error(`  ✗ Failed to create daily_revenue\n  ${error.message}`)
      return
    }
    logger.log(`  ✓ daily_revenue created → ${amountCents} cents`)
  }
}
