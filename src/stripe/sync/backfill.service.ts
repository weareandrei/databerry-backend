import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetter, type StripeGetter } from '../views/stripe-api.helpers'
import { makeStripeGetterForAccount } from './account-getter.helper'
import {
  bumpLastSyncedAt,
  setBackfillStatus,
  upsertAccount,
} from './persist.helper'
import { syncCharges, syncProducts } from './sync-range.helper'
import type { StripeAccountRow } from './types'

const BACKFILL_DAYS = 90

@Injectable()
export class StripeBackfillService {
  private readonly logger = new Logger(StripeBackfillService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Resolve a Stripe account from raw credentials (without needing an
   * existing `connections_*` row). Used at connection-creation time before
   * the FK is set, so we can know the account ID and dedup against existing
   * stripe_accounts rows.
   */
  async resolveAccountFromCredentials(get: StripeGetter): Promise<StripeAccountRow> {
    const account = (await get('account')) as unknown as StripeAccountRow
    if (!account?.id) {
      throw new Error('Stripe /v1/account returned no account id')
    }
    return account
  }

  /**
   * Resolve a Stripe account from a raw API key. Convenience wrapper for
   * manual-API-key connection creation.
   */
  async resolveAccountFromApiKey(apiKey: string): Promise<StripeAccountRow> {
    return this.resolveAccountFromCredentials(makeStripeGetter(apiKey))
  }

  /**
   * Kick off (or re-run) a 90-day backfill for a Stripe account. Idempotent:
   *   - if `backfill_status === 'complete'`, returns immediately;
   *   - if `'in_progress'`, returns immediately (some other connection's
   *     creation handler is already doing the work);
   *   - else marks the account `'in_progress'`, runs, and marks `'complete'`
   *     (or `'error'` on failure, leaving partial rows in place — re-running
   *     will reach a consistent state thanks to upsert).
   *
   * Fire-and-forget from the caller — does not block connection creation.
   */
  async backfillAccount(stripeAccountId: string): Promise<void> {
    const client = this.supabaseService.getClient()

    const { data: existing } = await client
      .from('stripe_accounts')
      .select('backfill_status')
      .eq('id', stripeAccountId)
      .maybeSingle()

    if (!existing) {
      this.logger.warn(`  ⚠ backfillAccount: ${stripeAccountId} row missing — caller must upsertAccount first`)
      return
    }

    if (existing.backfill_status === 'complete') {
      this.logger.log(`  → backfill skipped — ${stripeAccountId} already complete`)
      return
    }
    if (existing.backfill_status === 'in_progress') {
      this.logger.log(`  → backfill skipped — ${stripeAccountId} already in progress`)
      return
    }

    this.logger.log(`\n  ► backfillAccount START  account=${stripeAccountId}  window=${BACKFILL_DAYS}d`)

    try {
      await setBackfillStatus(client, stripeAccountId, 'in_progress')
      this.logger.log(`  → status=in_progress  account=${stripeAccountId}`)

      const get = await makeStripeGetterForAccount(client, stripeAccountId)

      // Products first — picker UI depends on it and we want it live before
      // the slow charges pass finishes. Pass the logger through so each page
      // gets logged; this is the single biggest source of "why is the picker
      // empty?" mystery and we want a paper trail.
      this.logger.log(`  → syncProducts BEGIN  account=${stripeAccountId}`)
      const productCount = await syncProducts(client, stripeAccountId, get, this.logger)
      this.logger.log(`  → syncProducts DONE   account=${stripeAccountId}  count=${productCount}`)

      const now = Math.floor(Date.now() / 1000)
      const since = now - BACKFILL_DAYS * 86_400

      this.logger.log(
        `  → syncCharges BEGIN   account=${stripeAccountId}  since=${new Date(since * 1000).toISOString()}`,
      )
      const chargeCount = await syncCharges(
        client,
        stripeAccountId,
        get,
        since,
        now,
        this.logger,
      )
      this.logger.log(`  → syncCharges DONE    account=${stripeAccountId}  count=${chargeCount}`)

      const { error: throughErr } = await client
        .from('stripe_accounts')
        .update({ backfilled_through: new Date(since * 1000).toISOString() })
        .eq('id', stripeAccountId)
      if (throughErr) {
        this.logger.warn(`  ⚠ failed to set backfilled_through: ${throughErr.message}`)
      }

      await setBackfillStatus(client, stripeAccountId, 'complete')
      await bumpLastSyncedAt(client, stripeAccountId)
      this.logger.log(
        `  ✓ backfillAccount END    account=${stripeAccountId}  products=${productCount}  charges=${chargeCount}  window=${BACKFILL_DAYS}d`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      this.logger.error(`  ✗ backfillAccount FAILED  account=${stripeAccountId}  msg="${msg}"`)
      if (stack) this.logger.error(stack)
      await setBackfillStatus(client, stripeAccountId, 'error', msg).catch(() => {})
    }
  }

  /**
   * One-shot helper for connection creation: ensures a stripe_accounts row
   * exists for the given account, then triggers backfill in the background.
   * Resolves immediately (does not await the backfill) so connection
   * creation isn't blocked.
   */
  async ensureAccountAndBackfill(account: StripeAccountRow): Promise<void> {
    const client = this.supabaseService.getClient()
    await upsertAccount(client, account)
    // Fire-and-forget — explicit `void` so eslint/no-floating-promises is happy
    void this.backfillAccount(account.id)
  }

  /**
   * Retry a backfill, regardless of current status. Used when the user
   * clicks "Retry" in the UI — for example after fixing a missing scope on
   * their Restricted Key, or when an account got stranded in `in_progress`
   * because the server restarted mid-run.
   *
   * Resets `backfill_status` to `'pending'` first so the normal idempotency
   * checks in `backfillAccount` don't short-circuit, then fires the backfill
   * in the background.
   */
  async retryBackfill(stripeAccountId: string): Promise<void> {
    const client = this.supabaseService.getClient()
    await setBackfillStatus(client, stripeAccountId, 'pending')
    void this.backfillAccount(stripeAccountId)
  }
}
