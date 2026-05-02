import type { Logger } from '@nestjs/common'
import type { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetterForAccount } from './account-getter.helper'
import { bumpLastSyncedAt } from './persist.helper'
import {
  syncCharges,
  syncCustomers,
  syncProducts,
  syncSubscriptions,
} from './sync-range.helper'

type Client = ReturnType<SupabaseService['getClient']>

/**
 * What triggered this sync — used purely for logging so we can correlate
 * "why did this Stripe API spend happen" between live, reload, reconnect,
 * reconcile, and the initial 90-day backfill.
 */
export type SyncTrigger =
  | 'backfill'
  | 'reconcile'
  | 'reconnect'
  | 'live'
  | 'reload'

export interface SyncOpts {
  /** Sync the full product catalogue. Heavy — only true on initial backfill / manual reload. */
  includeProducts?: boolean
  /** Sync the full customer list. Heavy — same caveat as products. */
  includeCustomers?: boolean
  /** Sync the full subscription list. Mandatory on reconcile (catches cancellations). */
  includeSubscriptions?: boolean
  /** For log correlation only. */
  triggeredBy?: SyncTrigger
}

export interface SyncResult {
  chargeCount: number
  productCount?: number
  customerCount?: number
  subCount?: number
}

/**
 * Single shared sync primitive — the body that backfill, reconcile, reconnect,
 * live-on-open, and manual-reload all call into. Pulls Stripe data into our
 * tables for the half-open `[since, until)` charge window plus the full sweeps
 * the caller opts into.
 *
 * Contract:
 *   - All-or-nothing freshness: `last_synced_at` is bumped ONLY on full
 *     success. Mid-sync errors leave partial rows in place (idempotent
 *     upserts make that safe), but `last_synced_at` doesn't advance, so the
 *     next caller covers the gap. Throws on Stripe / persistence failure.
 *   - Does NOT touch `backfill_status` — that's a lifecycle field owned by
 *     `backfillAccount`. This helper is a pure sync, not a workflow stage.
 *   - Does NOT touch `backfilled_through` — that marker is the *oldest*
 *     point we have data for, only `backfillAccount` (initial 90d) and
 *     `reloadRecent` (when a user reaches further back) move it.
 *   - Charges-only is the default. The full passes (products / customers /
 *     subs) are paginated full-list scans — 5–15s on busy accounts — so
 *     they're opt-in. Live-on-open does not enable any of them; reconnect /
 *     reconcile / backfill / reload do.
 */
export async function ensureSyncedThrough(
  client: Client,
  stripeAccountId: string,
  sinceUnix: number,
  untilUnix: number,
  opts: SyncOpts = {},
  logger?: Logger,
): Promise<SyncResult> {
  const tag = opts.triggeredBy ?? 'sync'
  const get = await makeStripeGetterForAccount(client, stripeAccountId)

  // Products first when included, so the picker UI sees fresh data before
  // the slower charges pass finishes (matches the existing backfill order).
  const productCount = opts.includeProducts
    ? await syncProducts(client, stripeAccountId, get, logger)
    : undefined
  if (productCount !== undefined) {
    logger?.log(`    [${tag}] syncProducts done — ${productCount}`)
  }

  const chargeCount = await syncCharges(
    client,
    stripeAccountId,
    get,
    sinceUnix,
    untilUnix,
    logger,
  )
  logger?.log(
    `    [${tag}] syncCharges done — ${chargeCount} (since=${new Date(
      sinceUnix * 1000,
    ).toISOString()} until=${new Date(untilUnix * 1000).toISOString()})`,
  )

  const customerCount = opts.includeCustomers
    ? await syncCustomers(client, stripeAccountId, get, logger)
    : undefined
  if (customerCount !== undefined) {
    logger?.log(`    [${tag}] syncCustomers done — ${customerCount}`)
  }

  const subCount = opts.includeSubscriptions
    ? await syncSubscriptions(client, stripeAccountId, get, logger)
    : undefined
  if (subCount !== undefined) {
    logger?.log(`    [${tag}] syncSubscriptions done — ${subCount}`)
  }

  // Single owner of last_synced_at. Bumping only on full success means a
  // mid-sync exception leaves the timestamp untouched — the next caller
  // (whatever it is) will cover the same window again.
  await bumpLastSyncedAt(client, stripeAccountId)

  return { chargeCount, productCount, customerCount, subCount }
}
