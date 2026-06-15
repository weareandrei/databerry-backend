-- ─── 7-day free trial columns ────────────────────────────────────────────
--
-- Run AFTER 2026-06-onboarding-complete.sql (same `accounts` table).
--
-- Both columns start NULL for everyone — including existing users.
-- The trial only STARTS when the user first opens /hub with
-- onboarding complete (finish or skip): the frontend `<TrialKickoff>`
-- calls `POST /accounts/me/start-trial`, which stamps both columns
-- atomically (now / now + 7 days) and the user sees the kickoff
-- popup + confetti exactly once.
--
-- Semantics after that:
--   trial_started_at NULL  → trial never began (user hasn't reached
--                            the dashboard yet). No gate, no popup.
--   trial_ends_at > now()  → trial running. `/accounts/me` reports
--                            effectivePlanId = 'starter' (free plan
--                            users get the full Starter feature set).
--   trial_ends_at < now()  → trial over. effectivePlanId falls back
--                            to plan_id; if that's still 'free', the
--                            frontend SubscriptionGate blocks the
--                            dashboard until they subscribe.
--
-- Users with a PAID plan_id never get a trial started (the endpoint
-- refuses) and are never gated — paying always wins.
--
-- NOTE for existing users (including your own account): they'll get
-- the trial popup on their next dashboard visit and 7 days later the
-- gate, unless their plan_id is set to a paid plan. To exempt an
-- account manually:  UPDATE accounts SET plan_id = 'pro' WHERE user_id = '<uuid>';

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
