import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ensureSyncedThrough, type SyncResult } from './ensure-synced.helper'

/**
 * Pulled from a connection-id by `resolveAccountForConnection`. The `type`
 * + `userId` lets the controller authorise the call against the user's
 * own connections without re-querying.
 */
interface ResolvedConnection {
  stripeAccountId: string
}

/** How long after the last successful sync we treat the data as "fresh". */
const LIVE_THROTTLE_MS = 60_000

/**
 * Hard ceiling on a live-on-open sync. Past this we give up and let the
 * caller serve DB data — better than a multi-second blocked dashboard
 * fetch on a slow Stripe response. Because `last_synced_at` is bumped
 * inside `ensureSyncedThrough` (only on full success), a timeout doesn't
 * advance it; the next caller will retry the same window.
 */
const LIVE_TIMEOUT_MS = 2_000

/**
 * Cap on how far back the live-sync path will pull on a single call. If
 * `last_synced_at` is much older than this (or null), the live path
 * narrows to this window — anything older is the reconnect / reload
 * path's concern, not "did anything happen since the user blinked".
 */
const LIVE_LOOKBACK_MAX_SECONDS = 24 * 3600

/** Default for the manual reload-from-Stripe action. */
const DEFAULT_RELOAD_DAYS = 30

/**
 * Result shape for `syncToNow`. Either a successful sync, a "throttled"
 * skip (data already fresh enough), or a "timeout" indicating the
 * background work is still running but we returned early.
 */
export type SyncToNowResult =
  | { skipped: 'recent'; lastSyncedAt: string | null }
  | { skipped: 'inflight' }
  | { synced: true; chargeCount: number; lastSyncedAt: string }
  | { timeout: true }

export interface ReloadResult {
  ok: true
  syncedFrom: string
  syncedTo: string
  chargeCount: number
  productCount?: number
  customerCount?: number
  subCount?: number
}

/**
 * Live sync service — owns:
 *   - `syncToNow(connectionId)`:  charges-only quick sync called by the
 *     dashboard on mount. Throttled, deduped per-account, capped at 2s.
 *   - `reloadRecent(connectionId, days)`:  manual reload triggered from the
 *     connections kebab menu. Full sweep (charges + products + customers
 *     + subs) over the last N days, no throttle.
 *
 * Why it's its own service (not folded into StripeBackfillService): the
 * in-memory inflight Map is request-deduplication state that's specific
 * to live-on-open — backfill / reconcile have different lifecycle
 * semantics (status field, fire-and-forget) and don't share the lock.
 */
@Injectable()
export class StripeLiveSyncService {
  private readonly logger = new Logger(StripeLiveSyncService.name)

  /**
   * Per-account inflight promises. When five tile fetches hit `/sync-now`
   * simultaneously (a fresh dashboard mount), four of them attach to the
   * same in-flight promise instead of firing four extra Stripe API calls.
   * Cleared in `.finally()` so a failed sync doesn't permanently block
   * the next attempt.
   *
   * Single-node only — if we ever shard this service, this falls apart
   * and we'd need a real distributed lock. For solo-founder scale, fine.
   */
  private inflight = new Map<string, Promise<SyncToNowResult>>()

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Quick "did anything happen since the user blinked" sync. Charges only —
   * subs / customers / products are full-list paginations that can take
   * 10s+ on busy accounts and aren't worth the latency hit on a dashboard
   * open. Reconcile + reconnect handle them.
   *
   * Returns one of:
   *   - { skipped: 'recent' }   — last sync was within `throttleMs` ago,
   *                                no work done.
   *   - { skipped: 'inflight' } — another caller is already running the
   *                                same sync; we attached to it.
   *   - { synced: true, ... }   — sync ran to completion within the 2s
   *                                ceiling.
   *   - { timeout: true }       — sync started but didn't finish in 2s.
   *                                The work continues in the background;
   *                                the caller should serve DB data and
   *                                let the next refresh pick up changes.
   */
  async syncToNow(
    connectionId: string,
    userId: string,
    throttleMs: number = LIVE_THROTTLE_MS,
  ): Promise<SyncToNowResult> {
    const { stripeAccountId } = await this.resolveAccountForConnection(
      connectionId,
      userId,
    )
    return this.syncAccountToNow(stripeAccountId, throttleMs)
  }

  private async syncAccountToNow(
    stripeAccountId: string,
    throttleMs: number,
  ): Promise<SyncToNowResult> {
    const client = this.supabaseService.getClient()

    // Layer 1: DB-based "recently synced" check. Cross-process / cross-tab —
    // any successful sync within the throttle window short-circuits the
    // next caller, regardless of which tab or even which Node process
    // (if we ever scale out) they came from.
    const { data: acc, error } = await client
      .from('stripe_accounts')
      .select('last_synced_at')
      .eq('id', stripeAccountId)
      .maybeSingle()

    if (error) throw new Error(`stripe_accounts read: ${error.message}`)
    if (!acc) {
      throw new NotFoundException(`stripe_account ${stripeAccountId} not found`)
    }

    const lastSyncedAt = (acc.last_synced_at as string | null) ?? null
    const lastSyncedMs = lastSyncedAt ? Date.parse(lastSyncedAt) : 0

    if (lastSyncedMs && Date.now() - lastSyncedMs < throttleMs) {
      return { skipped: 'recent', lastSyncedAt }
    }

    // Layer 2: in-memory inflight dedupe. Handles the "5 tile fetches in
    // parallel" case: layer-1 throttle is racy under burst (all five
    // requests read the same stale `last_synced_at`), but only one of
    // them gets to populate the inflight Map first.
    const existing = this.inflight.get(stripeAccountId)
    if (existing) {
      // Don't return the actual sync result — the caller wanted *their*
      // throttle decision, and "another tab won the race" is functionally
      // the same as "throttled". Avoids leaking inflight state.
      try {
        await existing
      } catch {
        // Swallow — the originating caller will see the error.
      }
      return { skipped: 'inflight' }
    }

    const work = this.runWithTimeout(stripeAccountId, lastSyncedMs)
    this.inflight.set(stripeAccountId, work)
    work.finally(() => this.inflight.delete(stripeAccountId)).catch(() => {})
    return work
  }

  private async runWithTimeout(
    stripeAccountId: string,
    lastSyncedMs: number,
  ): Promise<SyncToNowResult> {
    const client = this.supabaseService.getClient()
    const now = Math.floor(Date.now() / 1000)

    // Cap the lookback so a long-stale account doesn't quietly degrade the
    // live path into a multi-day pull. Anything older is the reconnect /
    // reload path's concern.
    const lookbackFloor = now - LIVE_LOOKBACK_MAX_SECONDS
    const since = Math.max(
      lastSyncedMs ? Math.floor(lastSyncedMs / 1000) : lookbackFloor,
      lookbackFloor,
    )

    const syncPromise = ensureSyncedThrough(
      client,
      stripeAccountId,
      since,
      now,
      { triggeredBy: 'live' },
      this.logger,
    )

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<{ timeout: true }>(resolve => {
      timeoutId = setTimeout(() => resolve({ timeout: true }), LIVE_TIMEOUT_MS)
    })

    try {
      const result = await Promise.race<SyncResult | { timeout: true }>([
        syncPromise,
        timeoutPromise,
      ])

      if ('timeout' in result) {
        // Don't await syncPromise — let it run on. Attach a catch so an
        // uncaught rejection doesn't crash the process; we don't have
        // anyone to surface it to at this point.
        syncPromise.catch(err => {
          const msg = err instanceof Error ? err.message : String(err)
          this.logger.warn(
            `  ⚠ live sync timed-out promise eventually rejected for ${stripeAccountId}: ${msg}`,
          )
        })
        return { timeout: true }
      }

      // Re-read `last_synced_at` so the response payload reflects what
      // ensureSyncedThrough wrote (rather than us computing `now` and
      // hoping the clocks agree).
      const { data: post } = await client
        .from('stripe_accounts')
        .select('last_synced_at')
        .eq('id', stripeAccountId)
        .maybeSingle()

      return {
        synced: true,
        chargeCount: result.chargeCount,
        lastSyncedAt:
          (post?.last_synced_at as string | null) ??
          new Date().toISOString(),
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  /**
   * Manual full reload over the last N days, triggered from the kebab
   * menu in the connections list. No throttle — the user clicked.
   *
   * Pulls everything (charges, products, customers, subs). If `since`
   * predates the existing `backfilled_through` marker, we expand it so
   * the dashboard knows the timeline has reached further back.
   *
   * Returns counts so the toast can give the user concrete feedback
   * ("Refreshed (12 charges, 3 customers)").
   */
  async reloadRecent(
    connectionId: string,
    userId: string,
    days: number = DEFAULT_RELOAD_DAYS,
  ): Promise<ReloadResult> {
    const client = this.supabaseService.getClient()
    const { stripeAccountId } = await this.resolveAccountForConnection(
      connectionId,
      userId,
    )

    const now = Math.floor(Date.now() / 1000)
    const since = now - days * 86_400

    this.logger.log(
      `\n  ► reloadRecent  account=${stripeAccountId}  days=${days}  conn=${connectionId}`,
    )

    const result = await ensureSyncedThrough(
      client,
      stripeAccountId,
      since,
      now,
      {
        includeProducts: true,
        includeCustomers: true,
        includeSubscriptions: true,
        triggeredBy: 'reload',
      },
      this.logger,
    )

    // Expand backfilled_through if the user reached further back than
    // we'd previously pulled. Preserves the "earliest data we have"
    // semantics that views can rely on.
    const sinceISO = new Date(since * 1000).toISOString()
    const { data: acc } = await client
      .from('stripe_accounts')
      .select('backfilled_through')
      .eq('id', stripeAccountId)
      .maybeSingle()

    const currentThrough = (acc?.backfilled_through as string | null) ?? null
    if (!currentThrough || Date.parse(currentThrough) > since * 1000) {
      const { error: updErr } = await client
        .from('stripe_accounts')
        .update({ backfilled_through: sinceISO })
        .eq('id', stripeAccountId)
      if (updErr) {
        this.logger.warn(
          `  ⚠ reloadRecent: failed to update backfilled_through: ${updErr.message}`,
        )
      }
    }

    this.logger.log(
      `  ✓ reloadRecent DONE  account=${stripeAccountId}  charges=${result.chargeCount}  products=${result.productCount}  customers=${result.customerCount}  subs=${result.subCount}`,
    )

    return {
      ok: true,
      syncedFrom: sinceISO,
      syncedTo: new Date(now * 1000).toISOString(),
      chargeCount: result.chargeCount,
      productCount: result.productCount,
      customerCount: result.customerCount,
      subCount: result.subCount,
    }
  }

  /**
   * Resolve a connection_id to its stripe_account_id, walking through the
   * `connections` row to dispatch on type. Enforces user ownership: a
   * caller can only sync connections they own (matches the same `eq(user_id)`
   * pattern used in `products.service` / `views.service`).
   *
   * Throws `NotFoundException` if the connection isn't a Stripe one,
   * doesn't belong to the user, or its credential row is missing.
   *
   * Mirrors the resolution in `views/storage-queries.ts` — deliberately not
   * imported from there because that module's read-only helpers shouldn't
   * depend on the sync layer or vice versa, and that helper doesn't enforce
   * ownership (its callers already have).
   */
  private async resolveAccountForConnection(
    connectionId: string,
    userId: string,
  ): Promise<ResolvedConnection> {
    const client = this.supabaseService.getClient()

    const { data: conn, error: connErr } = await client
      .from('connections')
      .select('type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (connErr) throw new Error(`connections read: ${connErr.message}`)
    if (!conn) {
      throw new NotFoundException(`Connection ${connectionId} not found`)
    }
    const type = conn.type as string

    const credTable =
      type === 'stripe_manual'
        ? 'connections_stripe_manual'
        : type === 'stripe'
          ? 'connections_stripe'
          : null
    if (!credTable) {
      throw new NotFoundException(
        `Connection ${connectionId} is type=${type}, not a Stripe connection`,
      )
    }

    const { data: cred, error: credErr } = await client
      .from(credTable)
      .select('stripe_account_id')
      .eq('connection_id', connectionId)
      .maybeSingle()
    if (credErr) throw new Error(`${credTable} read: ${credErr.message}`)
    if (!cred?.stripe_account_id) {
      throw new NotFoundException(
        `Connection ${connectionId} has no stripe_account_id linked yet`,
      )
    }

    return { stripeAccountId: cred.stripe_account_id as string }
  }
}
