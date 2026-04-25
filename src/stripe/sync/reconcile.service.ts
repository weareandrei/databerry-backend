import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetterForAccount } from './account-getter.helper'
import { bumpLastSyncedAt } from './persist.helper'
import { syncCharges } from './sync-range.helper'

const RECONCILE_WINDOW_HOURS = 48

/**
 * Nightly safety net for missed webhooks. For every account whose backfill is
 * complete, re-pull the last 48h of charges and upsert. Idempotent — if every
 * webhook landed, this is a no-op (existing rows get re-written with the same
 * values). Catches gaps from network failures, server downtime, or webhook
 * endpoint misconfiguration.
 *
 * Not called for accounts that are still backfilling — that path covers their
 * recent history already.
 */
@Injectable()
export class StripeReconcileService {
  private readonly logger = new Logger(StripeReconcileService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /** Cron: 02:00 UTC daily — well past the 30-min view-sync sweep. */
  @Cron('0 0 2 * * *')
  async reconcileAllAccounts(): Promise<void> {
    const client = this.supabaseService.getClient()

    const { data: accounts, error } = await client
      .from('stripe_accounts')
      .select('id')
      .eq('backfill_status', 'complete')

    if (error) {
      this.logger.error(`  ✗ failed to list accounts: ${error.message}`)
      return
    }

    if (!accounts || accounts.length === 0) {
      this.logger.log('  → reconcile: no accounts to sweep')
      return
    }

    this.logger.log(`\n  ► reconcileAllAccounts  count=${accounts.length}  window=${RECONCILE_WINDOW_HOURS}h`)

    for (const a of accounts) {
      await this.reconcileAccount(a.id as string)
    }
  }

  async reconcileAccount(stripeAccountId: string): Promise<void> {
    const client = this.supabaseService.getClient()

    try {
      const get = await makeStripeGetterForAccount(client, stripeAccountId)

      const now = Math.floor(Date.now() / 1000)
      const since = now - RECONCILE_WINDOW_HOURS * 3600

      const count = await syncCharges(client, stripeAccountId, get, since, now, this.logger)
      await bumpLastSyncedAt(client, stripeAccountId)
      this.logger.log(`  ✓ reconciled ${stripeAccountId} — ${count} charge(s) over last ${RECONCILE_WINDOW_HOURS}h`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`  ✗ reconcile failed for ${stripeAccountId}: ${msg}`)
      // Leave last_synced_at alone — partial state preserved, next run retries.
    }
  }
}
