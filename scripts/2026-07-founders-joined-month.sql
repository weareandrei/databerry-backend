-- ─── Fake "founders joined this month" social-proof counter ───────────────
--
-- Singleton row used by `GET /founders-joined` on the landing page.
-- The backend reads `count` + `updated_at`, rolls a 10% join chance per
-- elapsed full hour since `updated_at`, then writes the new count and
-- bumps `updated_at`. Monthly resets are manual (you edit `count`).
--
-- Run in Supabase Studio → SQL editor.

CREATE TABLE IF NOT EXISTS public.founders_joined_month (
  -- Force a single row — the counter is global, not per-user.
  id          integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  count       integer     NOT NULL DEFAULT 34 CHECK (count >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton if missing. Safe to re-run.
INSERT INTO public.founders_joined_month (id, count, updated_at)
VALUES (1, 34, now())
ON CONFLICT (id) DO NOTHING;

-- Backend uses the service-role key (bypasses RLS). Lock the table
-- down so the anon key can't read/write the fake counter directly.
ALTER TABLE public.founders_joined_month ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.founders_joined_month IS
  'Landing-page social proof: fake founders-joined-this-month counter.';
