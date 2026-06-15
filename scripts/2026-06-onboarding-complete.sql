-- ============================================================
-- Onboarding completion flag on accounts
-- ============================================================
--
-- `onboarding_complete` answers "should /hub bounce this user into
-- the onboarding flow?". The flow lives at /onboarding (frontend);
-- the hub layout checks this flag and redirects when FALSE.
--
-- Why a DB column (vs localStorage): the user can close the tab
-- mid-onboarding, or get redirected away by an OAuth flow
-- (Google Analytics / Calendly consent screens land back on the
-- dashboard) — the flag is the only durable way to know they never
-- finished, regardless of which device/browser they come back on.
--
-- Both "finished" and "skipped" set it TRUE — skipping is a valid
-- exit (we never nag again); the difference is only a PostHog
-- event fired client-side.
--
-- Existing accounts are GRANDFATHERED to TRUE: they were created
-- before onboarding existed, and bouncing long-time users into a
-- welcome wizard on their next login would be hostile. Only
-- accounts created after this migration (DEFAULT FALSE) see it.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- Grandfather every existing account.
UPDATE accounts SET onboarding_complete = TRUE;
