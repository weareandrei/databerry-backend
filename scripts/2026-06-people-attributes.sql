-- ============================================================
-- People display attributes — source / country / last-seen
-- ============================================================
--
-- Adds the columns the project Overview "People" table renders.
-- Until now `people` only carried name + email; the matcher fills
-- these from each platform's data:
--
--   • last_seen_at   — the platform's timestamp for the person
--     (PostHog person `created_at`, Stripe customer `created`).
--     It's the sort key for "earliest → latest" and the displayed
--     "Last seen" value. NOTE: with no event ingestion yet (Phase 3),
--     this is effectively the FIRST-seen time; once events land it
--     becomes true last-activity. One column, future-proof.
--
--   • country        — ISO 3166-1 alpha-2 code (e.g. 'US'). From
--     PostHog `$geoip_country_code`, Stripe `address.country`. The
--     frontend derives the flag + display name from the code.
--
--   • initial_source — first-touch traffic source. From PostHog
--     `$initial_referring_domain` (or `$initial_utm_source`); '$direct'
--     is normalised to 'direct'. NULL for Stripe-only people (no
--     traffic source exists for a card payment).
--
-- All nullable, all enrich-on-observe (the matcher keeps the EARLIEST
-- last_seen? no — the LATEST; and the FIRST non-null country/source).
-- Safe to run once; `IF NOT EXISTS` makes re-runs no-ops.

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS country        TEXT,
  ADD COLUMN IF NOT EXISTS initial_source TEXT;

-- The People table sorts by last_seen_at; index it (partial — rows
-- without the value sort last and don't need to sit in the index).
CREATE INDEX IF NOT EXISTS idx_people_project_last_seen
  ON public.people(project_id, last_seen_at)
  WHERE last_seen_at IS NOT NULL;
