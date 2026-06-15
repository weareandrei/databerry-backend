import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { makeStripeGetter, type StripeGetter } from '../views/stripe-api.helpers'
import { ensureSyncedThrough } from './ensure-synced.helper'
import {
  setBackfillStatus,
  upsertAccount,
} from './persist.helper'
import type { StripeAccountRow } from './types'

const BACKFILL_DAYS = 90

/**
 * How long an `in_progress` row can sit before we treat it as orphaned and
 * reclaim it. A real backfill of a 90-day window is seconds-to-a-minute on
 * tiny accounts and a few minutes on busy ones; anything older than this is
 * almost certainly a crashed/restarted process.
 *
 * Without this, a server restart mid-backfill (or an exception thrown
 * BEFORE the catch handler can write `'error'` — for example if the
 * `stripe_accounts` row schema is missing the `backfill_error` column)
 * leaves the user permanently stuck behind "Importing 90 days of payment
 * history…", because every subsequent `backfillAccount` call short-circuits
 * on the stale `in_progress` flag.
 */
const STALE_IN_PROGRESS_MS = 5 * 60_000 // 5 minutes

/**
 * Determine livemode from a Stripe key/token prefix. Stripe encodes mode in
 * every key kind we care about: secret keys (`sk_test_*` / `sk_live_*`),
 * restricted keys (`rk_test_*` / `rk_live_*`), and OAuth access tokens
 * (which are issued as `sk_test_*` / `sk_live_*` depending on the mode the
 * user authorised in). Publishable keys (`pk_*`) aren't used here, but
 * follow the same pattern.
 *
 * We only fall back to this when Stripe's `/v1/account` response omits
 * `livemode` (observed for some restricted-key permission shapes). The
 * prefix is authoritative — Stripe will refuse mismatched calls on the
 * same key, so there's no ambiguity to resolve.
 */
function deriveLivemodeFromKey(key: string): boolean {
  if (key.includes('_live_')) return true
  if (key.includes('_test_')) return false
  // Defensive: rather than guess, fail loudly. Better to surface an
  // unexpected key shape now than to mis-record an account as test/live.
  throw new Error(
    `Cannot derive livemode from Stripe key — expected '*_test_*' or '*_live_*' in prefix`,
  )
}

@Injectable()
export class StripeBackfillService {
  private readonly logger = new Logger(StripeBackfillService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Resolve a Stripe account from raw credentials (without needing an
   * existing `connections_*` row). Used at connection-creation time before
   * the FK is set, so we can know the account ID and dedup against existing
   * stripe_accounts rows.
   *
   * Pass `key` so we can derive `livemode` when the Stripe API omits it.
   * Restricted Keys (`rk_*`) sometimes return a trimmed Account payload
   * without `livemode`, which we can't store (NOT NULL on the column).
   * The key prefix (`*_test_*` vs `*_live_*`) is authoritative and never
   * lies, so we use it as a fallback. For OAuth, `key` is the access
   * token (`sk_test_*` / `sk_live_*`), which encodes mode the same way.
   */
  async resolveAccountFromCredentials(
    get: StripeGetter,
    key: string,
  ): Promise<StripeAccountRow> {
    let account: StripeAccountRow
    try {
      account = (await get('account')) as unknown as StripeAccountRow
    } catch (err) {
      // Restricted keys created per our setup instructions (Read on
      // Charges / Customers / Subscriptions / Products) do NOT carry
      // `accounts_kyc_basic_read` ("Basic Business Contact
      // Information"), which Stripe now requires for /v1/account.
      // That failure does NOT mean the key is bad — Stripe
      // AUTHENTICATED it (the permission error even names the
      // account id). Rejecting here forced users to grant a KYC
      // permission we never use, purely to satisfy our own probe.
      //
      // Recovery: pull the `acct_…` id out of Stripe's error text,
      // then prove the key can read what we ACTUALLY need with a
      // 1-charge probe. Genuinely invalid keys (rotated / deleted)
      // fail with no account id in the message and still reject.
      const msg = err instanceof Error ? err.message : String(err)
      const acctId = /acct_[A-Za-z0-9]+/.exec(msg)?.[0]
      const scopeLimited = /required permissions|Permission denied/i.test(msg)
      if (!acctId || !scopeLimited) throw err

      this.logger.log(
        `  → /v1/account is scope-limited for this restricted key; recovered ${acctId} from the error. Probing Charges read…`,
      )
      try {
        await get('charges', { limit: '1' })
      } catch (probeErr) {
        const probeMsg =
          probeErr instanceof Error ? probeErr.message : String(probeErr)
        if (/required permissions|Permission denied/i.test(probeMsg)) {
          // The key authenticates but can't read the data we chart —
          // THIS is the precise, actionable rejection.
          throw new Error(
            "this key can't read Charges. Edit the key in the Stripe Dashboard and grant Read access to Charges, Customers, Subscriptions, and Products",
          )
        }
        throw probeErr
      }

      return {
        id: acctId,
        business_profile: null,
        livemode: deriveLivemodeFromKey(key),
      }
    }

    if (!account?.id) {
      throw new Error('Stripe /v1/account returned no account id')
    }
    if (typeof account.livemode !== 'boolean') {
      account.livemode = deriveLivemodeFromKey(key)
    }
    return account
  }

  /**
   * Resolve a Stripe account from a raw API key. Convenience wrapper for
   * manual-API-key connection creation.
   */
  async resolveAccountFromApiKey(apiKey: string): Promise<StripeAccountRow> {
    return this.resolveAccountFromCredentials(makeStripeGetter(apiKey), apiKey)
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
      .select('backfill_status, backfill_started_at')
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
      // Reclaim the row if the previous run looks orphaned. Without this, a
      // crash or process restart mid-backfill traps the account forever (the
      // user just sees the picker spinner; we'd see "already in progress" in
      // logs every time they retry).
      const startedAt = existing.backfill_started_at as string | null
      const ageMs = startedAt ? Date.now() - Date.parse(startedAt) : Infinity
      if (ageMs < STALE_IN_PROGRESS_MS) {
        this.logger.log(
          `  → backfill skipped — ${stripeAccountId} already in progress (age=${Math.round(ageMs / 1000)}s)`,
        )
        return
      }
      this.logger.warn(
        `  ⚠ backfill: ${stripeAccountId} stuck 'in_progress' for ${
          startedAt ? `${Math.round(ageMs / 1000)}s` : 'unknown duration (no started_at)'
        } — treating as orphan and restarting`,
      )
    }

    this.logger.log(`\n  ► backfillAccount START  account=${stripeAccountId}  window=${BACKFILL_DAYS}d`)

    try {
      await setBackfillStatus(client, stripeAccountId, 'in_progress')
      this.logger.log(`  → status=in_progress  account=${stripeAccountId}`)

      const now = Math.floor(Date.now() / 1000)
      const since = now - BACKFILL_DAYS * 86_400

      // Heavy passes are all on for a backfill — first-time setup needs the
      // full catalogue (picker), customer table (top-customers tile), and
      // subscription set (MRR/churn).
      const result = await ensureSyncedThrough(
        client,
        stripeAccountId,
        since,
        now,
        {
          includeProducts: true,
          includeCustomers: true,
          includeSubscriptions: true,
          triggeredBy: 'backfill',
        },
        this.logger,
      )

      const { error: throughErr } = await client
        .from('stripe_accounts')
        .update({ backfilled_through: new Date(since * 1000).toISOString() })
        .eq('id', stripeAccountId)
      if (throughErr) {
        this.logger.warn(`  ⚠ failed to set backfilled_through: ${throughErr.message}`)
      }

      await setBackfillStatus(client, stripeAccountId, 'complete')
      this.logger.log(
        `  ✓ backfillAccount END    account=${stripeAccountId}  products=${result.productCount}  charges=${result.chargeCount}  customers=${result.customerCount}  subs=${result.subCount}  window=${BACKFILL_DAYS}d`,
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
   * Upsert a stripe_accounts row from a freshly-resolved account. Awaited.
   *
   * Connection-creation callers MUST call this BEFORE inserting the
   * credential row (`connections_stripe` / `connections_stripe_manual`),
   * because those tables FK into `stripe_accounts.id`. Calling this
   * helper after the credential insert is a foreign-key violation.
   *
   * Idempotent (`upsertAccount` uses `onConflict: 'id'`). Cheap to call
   * twice.
   */
  async upsertAccountRow(account: StripeAccountRow): Promise<void> {
    const client = this.supabaseService.getClient()
    await upsertAccount(client, account)
  }

  /**
   * Kick a fire-and-forget 90-day backfill. Returns immediately — the
   * actual work runs in the background via `backfillAccount`. Callers
   * MUST have already (a) upserted the `stripe_accounts` row and
   * (b) inserted the credential row, otherwise the backfill's
   * `makeStripeGetterForAccount` lookup will fail to find credentials
   * and the run will end in `backfill_status='error'`.
   */
  kickBackfill(stripeAccountId: string): void {
    // Fire-and-forget — explicit `void` so eslint/no-floating-promises is happy
    void this.backfillAccount(stripeAccountId)
  }

  /**
   * Connection-creation entrypoint. Replaces a bare `kickBackfill` for the
   * connect path because of the account-dedup bug: when a user connects a
   * second connection to an already-backfilled `stripe_accounts` row,
   * `kickBackfill` short-circuits on `backfill_status='complete'` and
   * pulls nothing — even if the last sync was hours or days ago.
   *
   * This method:
   *   - First-time / previously errored accounts → run a normal 90d backfill.
   *   - Already-completed accounts → fill the gap from `last_synced_at` to
   *     now via `ensureSyncedThrough` (charges + subs, full set, since the
   *     reconnect is a "settle the picture" event for the user).
   *
   * Fire-and-forget. Errors are caught + logged; failures don't propagate
   * to the connection-creation request — the user already has a working
   * connection, the sync is opportunistic.
   */
  kickBackfillOnConnect(stripeAccountId: string): void {
    void this.runReconnectSync(stripeAccountId)
  }

  private async runReconnectSync(stripeAccountId: string): Promise<void> {
    const client = this.supabaseService.getClient()
    try {
      const { data: existing } = await client
        .from('stripe_accounts')
        .select('backfill_status, last_synced_at')
        .eq('id', stripeAccountId)
        .maybeSingle()

      if (!existing) {
        this.logger.warn(
          `  ⚠ kickBackfillOnConnect: ${stripeAccountId} row missing — caller must upsertAccount first`,
        )
        return
      }

      // Not finished a first-time backfill yet → use the lifecycle path.
      if (existing.backfill_status !== 'complete') {
        await this.backfillAccount(stripeAccountId)
        return
      }

      // Already complete. Fill any gap since the last sync. Cap at 24h so
      // a long-stale `last_synced_at` doesn't degrade into a near-full
      // backfill via the live-sync path; 24h matches what reconcile would
      // catch anyway, and going further back is a manual-reload concern.
      const lastSyncedAt = (existing.last_synced_at as string | null) ?? null
      const now = Math.floor(Date.now() / 1000)
      const lastSyncedUnix = lastSyncedAt
        ? Math.floor(Date.parse(lastSyncedAt) / 1000)
        : 0
      const since = Math.max(lastSyncedUnix, now - 24 * 3600)

      this.logger.log(
        `\n  ► kickBackfillOnConnect (gap-fill)  account=${stripeAccountId}  since=${new Date(
          since * 1000,
        ).toISOString()}`,
      )

      const result = await ensureSyncedThrough(
        client,
        stripeAccountId,
        since,
        now,
        {
          includeSubscriptions: true,
          triggeredBy: 'reconnect',
        },
        this.logger,
      )
      this.logger.log(
        `  ✓ kickBackfillOnConnect DONE  account=${stripeAccountId}  charges=${result.chargeCount}  subs=${result.subCount}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `  ✗ kickBackfillOnConnect FAILED  account=${stripeAccountId}  msg="${msg}"`,
      )
    }
  }

  /**
   * @deprecated Prefer the explicit two-step `upsertAccountRow` (before
   * the credential insert) + `kickBackfill` (after it). This composite
   * helper kicks the backfill before the credential row is in place,
   * which races and can leave the account stuck in `backfill_status='error'`.
   * Kept only for paths that don't FK into `stripe_accounts`.
   */
  async ensureAccountAndBackfill(account: StripeAccountRow): Promise<void> {
    await this.upsertAccountRow(account)
    this.kickBackfill(account.id)
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
