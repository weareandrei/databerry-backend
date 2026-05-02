import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { SupabaseService } from '../../supabase/supabase.service'
import { ensureSyncedThrough } from './ensure-synced.helper'

/**
 * Reconcile window. Wider than just "missed webhooks" because Stripe doesn't
 * expose a `?modified[gte]` filter — refunds, dispute openings, and other
 * mutations on existing charges only get caught when this window covers
 * the original `created` timestamp. 7 days is a comfortable safety net for
 * dispute-of-yesterday-style mutations without making the nightly sweep
 * expensive (a 7-day charge list is still <500ms for typical accounts).
 */
const RECONCILE_WINDOW_HOURS = 7 * 24

/**
 * Nightly safety net for missed webhooks AND mutation events (refunds,
 * disputes) that wouldn't trigger a webhook on the linked account. For every
 * account whose backfill is complete, re-pull the last 7 days of charges
 * plus the full subscription set. Idempotent — if every webhook landed,
 * this is a no-op (existing rows get re-written with the same values).
 *
 * Not called for accounts that are still backfilling — that path covers
 * their recent history already.
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

    this.logger.log(
      `\n  ► reconcileAllAccounts  count=${accounts.length}  window=${RECONCILE_WINDOW_HOURS}h`,
    )

    for (const a of accounts) {
      await this.reconcileAccount(a.id as string)
    }
  }

  async reconcileAccount(stripeAccountId: string): Promise<void> {
    const client = this.supabaseService.getClient()

    try {
      const now = Math.floor(Date.now() / 1000)
      const since = now - RECONCILE_WINDOW_HOURS * 3600

      // Subscriptions are unwindowed (status=all); we always pull the full
      // set so we catch cancellations between webhook deliveries.
      // Charges/products/customers don't transition state once created, so
      // the 7d window is enough for them.
      const result = await ensureSyncedThrough(
        client,
        stripeAccountId,
        since,
        now,
        {
          includeSubscriptions: true,
          triggeredBy: 'reconcile',
        },
        this.logger,
      )

      this.logger.log(
        `  ✓ reconciled ${stripeAccountId} — ${result.chargeCount} charge(s) over last ${RECONCILE_WINDOW_HOURS}h, ${result.subCount} sub(s)`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`  ✗ reconcile failed for ${stripeAccountId}: ${msg}`)
      // ensureSyncedThrough did NOT bump last_synced_at on failure —
      // partial state preserved, next run retries.
    }
  }
}
