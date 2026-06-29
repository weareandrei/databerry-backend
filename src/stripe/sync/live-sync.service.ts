import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  ConnectionsRepository,
  type StripeCredentialTable,
} from '../../connections/connections.repository'
import { StripeRepository } from '../stripe.repository'
import { ensureSyncedThrough, type StripeSyncRepos, type SyncResult } from './ensure-synced.helper'

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

@Injectable()
export class StripeLiveSyncService {
  private readonly logger = new Logger(StripeLiveSyncService.name)

  private inflight = new Map<string, Promise<SyncToNowResult>>()

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly stripeRepository: StripeRepository,
  ) {}

  private syncRepos(): StripeSyncRepos {
    return {
      stripe: this.stripeRepository,
      connections: this.connectionsRepository,
    }
  }

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
    const { data: acc, error } =
      await this.stripeRepository.findLastSyncedAt(stripeAccountId)

    if (error) throw new Error(`stripe_accounts read: ${error.message}`)
    if (!acc) {
      throw new NotFoundException(`stripe_account ${stripeAccountId} not found`)
    }

    const lastSyncedAt = (acc.last_synced_at as string | null) ?? null
    const lastSyncedMs = lastSyncedAt ? Date.parse(lastSyncedAt) : 0

    if (lastSyncedMs && Date.now() - lastSyncedMs < throttleMs) {
      return { skipped: 'recent', lastSyncedAt }
    }

    const existing = this.inflight.get(stripeAccountId)
    if (existing) {
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
    const now = Math.floor(Date.now() / 1000)

    const lookbackFloor = now - LIVE_LOOKBACK_MAX_SECONDS
    const since = Math.max(
      lastSyncedMs ? Math.floor(lastSyncedMs / 1000) : lookbackFloor,
      lookbackFloor,
    )

    const syncPromise = ensureSyncedThrough(
      this.syncRepos(),
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
        syncPromise.catch(err => {
          const msg = err instanceof Error ? err.message : String(err)
          this.logger.warn(
            `  ⚠ live sync timed-out promise eventually rejected for ${stripeAccountId}: ${msg}`,
          )
        })
        return { timeout: true }
      }

      const { data: post } =
        await this.stripeRepository.findLastSyncedAt(stripeAccountId)

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

  async reloadRecent(
    connectionId: string,
    userId: string,
    days: number = DEFAULT_RELOAD_DAYS,
  ): Promise<ReloadResult> {
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
      this.syncRepos(),
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

    const sinceISO = new Date(since * 1000).toISOString()
    const { data: acc } =
      await this.stripeRepository.findBackfilledThrough(stripeAccountId)

    const currentThrough = (acc?.backfilled_through as string | null) ?? null
    if (!currentThrough || Date.parse(currentThrough) > since * 1000) {
      const { error: updErr } = await this.stripeRepository.updateAccount(
        stripeAccountId,
        { backfilled_through: sinceISO },
      )
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

  private async resolveAccountForConnection(
    connectionId: string,
    userId: string,
  ): Promise<ResolvedConnection> {
    const { data: conn, error: connErr } =
      await this.connectionsRepository.findTypeById(connectionId, userId)
    if (connErr) throw new Error(`connections read: ${connErr.message}`)
    if (!conn) {
      throw new NotFoundException(`Connection ${connectionId} not found`)
    }
    const type = conn.type as string

    const credTable = this.credentialTableForType(type)
    if (!credTable) {
      throw new NotFoundException(
        `Connection ${connectionId} is type=${type}, not a Stripe connection`,
      )
    }

    const { data: cred, error: credErr } =
      await this.connectionsRepository.findStripeAccountId(connectionId, credTable)
    if (credErr) throw new Error(`${credTable} read: ${credErr.message}`)
    if (!cred?.stripe_account_id) {
      throw new NotFoundException(
        `Connection ${connectionId} has no stripe_account_id linked yet`,
      )
    }

    return { stripeAccountId: cred.stripe_account_id as string }
  }

  private credentialTableForType(type: string): StripeCredentialTable | null {
    if (type === 'stripe_manual') return 'connections_stripe_manual'
    if (type === 'stripe') return 'connections_stripe'
    return null
  }
}
