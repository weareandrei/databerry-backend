import { Injectable } from '@nestjs/common'
import { AccountsRepository } from './accounts.repository'

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
  constructor(private readonly accountsRepository: AccountsRepository) {}

  async getOrCreateAccount(userId: string): Promise<Account> {
    const { data, error } = await this.accountsRepository.upsertByUserId(userId)
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
    await this.getOrCreateAccount(userId)

    const { data, error } = await this.accountsRepository.markOnboardingComplete(userId)
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

    const { data, error } = await this.accountsRepository.startTrialIfUnset(
      userId,
      startedAt.toISOString(),
      endsAt.toISOString(),
    )

    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return this.getOrCreateAccount(userId)
    return this.toCamel(data[0])
  }

  private toCamel(row: Record<string, unknown>): Account {
    const planId = (row.plan_id as string) ?? 'free'
    const trialEndsAt = (row.trial_ends_at as string | null) ?? null

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
      onboardingComplete: row.onboarding_complete === true,
      trialStartedAt: (row.trial_started_at as string | null) ?? null,
      trialEndsAt,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
