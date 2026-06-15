import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

/** Length of the free trial granted on first dashboard open. */
const TRIAL_DAYS = 7

export interface Account {
  id: string
  userId: string
  planId: string
  /**
   * The plan the user should be TREATED as right now:
   *   - paid `plan_id` → itself (paying always wins, no trial logic)
   *   - 'free' + active trial (`trial_ends_at` in the future) → 'starter'
   *   - 'free' + no/expired trial → 'free'
   * Frontend consumers (limits, sidebar badge, tier picker) read THIS,
   * not `planId` — so a trialing user gets the full Starter feature
   * set without us touching `plan_id` (which still records what they
   * actually pay for, i.e. nothing).
   */
  effectivePlanId: string
  /**
   * Whether the user has finished (or explicitly skipped) the
   * /onboarding flow. FALSE on fresh accounts → the hub layout
   * redirects them into onboarding until this flips. Set via
   * `markOnboardingComplete`; never unset. Skipping counts as
   * complete — we never re-nag; the skip/finish distinction lives
   * only in PostHog events fired client-side.
   */
  onboardingComplete: boolean
  /**
   * NULL until the user's first post-onboarding dashboard open —
   * the trial clock does NOT start at signup. Stamped (with
   * `trialEndsAt`) by `startTrial`, exactly once, never reset.
   */
  trialStartedAt: string | null
  trialEndsAt: string | null
  createdAt: string
  updatedAt: string
}

@Injectable()
export class AccountsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async getOrCreateAccount(userId: string): Promise<Account> {
    const client = this.supabaseService.getClient()

    // Upsert — safe to call on every request, trigger handles signup but this
    // acts as a fallback for users who existed before the trigger was added.
    const { data, error } = await client
      .from('accounts')
      .upsert({ user_id: userId }, { onConflict: 'user_id' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return this.toCamel(data)
  }

  /**
   * Flip `onboarding_complete` to TRUE for the user's account row.
   * Idempotent — re-marking an already-complete account is a no-op
   * update. Routes through `getOrCreateAccount` first so a missing
   * row (pre-trigger user) is healed rather than silently updating
   * zero rows.
   */
  async markOnboardingComplete(userId: string): Promise<Account> {
    // Ensure the row exists (idempotent upsert), then set the flag.
    await this.getOrCreateAccount(userId)

    const { data, error } = await this.supabaseService
      .getClient()
      .from('accounts')
      .update({ onboarding_complete: true })
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return this.toCamel(data)
  }

  /**
   * Start the user's 7-day free trial — called by the frontend the
   * first time the dashboard renders after onboarding completes.
   *
   * Guarantees:
   *   - IDEMPOTENT: a second call (second tab, remount, retry) finds
   *     `trial_started_at` already set and returns the row unchanged.
   *     The `.is('trial_started_at', null)` filter makes the stamp
   *     atomic — two concurrent calls race on the DB row and exactly
   *     one performs the update; the loser's update matches 0 rows
   *     and falls through to a plain read.
   *   - PAID USERS EXEMPT: a non-'free' `plan_id` (manual comp, real
   *     subscription) never gets a trial clock — they'd gain nothing
   *     and the eventual "trial ended" gate would be nonsense.
   *
   * The caller can tell whether THIS call started the trial by
   * comparing `trialStartedAt` before/after — the frontend uses its
   * own pre-call read (`trialStartedAt === null`) to decide whether
   * to celebrate, so the endpoint stays a dumb idempotent stamp.
   */
  async startTrial(userId: string): Promise<Account> {
    const existing = await this.getOrCreateAccount(userId)
    if (existing.trialStartedAt !== null) return existing
    if (existing.planId !== 'free') return existing

    const startedAt = new Date()
    const endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)

    const { data, error } = await this.supabaseService
      .getClient()
      .from('accounts')
      .update({
        trial_started_at: startedAt.toISOString(),
        trial_ends_at: endsAt.toISOString(),
      })
      .eq('user_id', userId)
      .is('trial_started_at', null)
      .select()

    if (error) throw new Error(error.message)
    // 0 rows updated → another request won the race between our read
    // and our update. Re-read for the winner's timestamps.
    if (!data || data.length === 0) return this.getOrCreateAccount(userId)
    return this.toCamel(data[0])
  }

  private toCamel(row: Record<string, unknown>): Account {
    const planId = (row.plan_id as string) ?? 'free'
    const trialEndsAt = (row.trial_ends_at as string | null) ?? null

    // Effective plan: paid plan wins outright; otherwise an unexpired
    // trial upgrades 'free' to 'starter'. Computed at read time (not
    // stored) so expiry needs no cron — the moment `now` passes
    // `trial_ends_at`, every subsequent read reports 'free' again.
    let effectivePlanId = planId
    if (planId === 'free' && trialEndsAt !== null) {
      const ends = Date.parse(trialEndsAt)
      if (!Number.isNaN(ends) && ends > Date.now()) effectivePlanId = 'starter'
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      planId,
      effectivePlanId,
      // `=== true` so a missing column (migration not yet run) reads
      // as FALSE for fresh rows but doesn't crash the mapper.
      onboardingComplete: row.onboarding_complete === true,
      trialStartedAt: (row.trial_started_at as string | null) ?? null,
      trialEndsAt,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
