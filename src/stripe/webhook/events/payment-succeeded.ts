import { Logger } from '@nestjs/common'
import { markNeedsSync } from '../../../views/views-sync.helper'
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

  const today = new Date().toISOString().split('T')[0]
  logger.log(`  → matched ${views.length} daily_revenue view(s) — marking needs_sync for ${today}`)

  for (const view of views as { id: string }[]) {
    await markNeedsSync(view.id, today, client)
  }
}
