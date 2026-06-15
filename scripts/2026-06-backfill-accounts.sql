-- ============================================================
-- Backfill: one accounts row per existing auth user
-- ============================================================
--
-- Context: the old `on_auth_user_created` DB trigger silently died
-- (again), so 42 of 43 auth users have no accounts row. Decision:
-- we NO LONGER rely on triggers for account creation at all —
-- creation is app-level now:
--
--   1. `AuthContext` (frontend) calls `GET /accounts/me` the moment
--      any page sees an authenticated session — covers email,
--      Google OAuth, magic links, every path, on every device.
--   2. `getOrCreateAccount` (backend) upserts the row on that call.
--   3. Failures are no longer swallowed — they're reported to
--      PostHog error tracking so a prod regression is visible.
--
-- This script is the one-time repair for the users created while
-- the trigger was dead.
--
-- Onboarding note: run AFTER 2026-06-onboarding-complete.sql.
-- These backfilled rows get onboarding_complete = FALSE (column
-- default) → returning users see the new /onboarding flow. That's
-- intentional — they never set anything up.

INSERT INTO public.accounts (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Sanity check — both counts should match:
--   SELECT (SELECT count(*) FROM auth.users)      AS auth_users,
--          (SELECT count(*) FROM public.accounts) AS account_rows;
