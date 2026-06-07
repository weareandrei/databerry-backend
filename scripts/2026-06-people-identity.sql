-- ============================================================
-- Cross-platform People (identity graph) — Phase 1 data layer
-- ============================================================
--
-- Introduces the foundation for "show a Databerry customer THEIR
-- end-users and what those users did across PostHog / GA / Stripe".
--
-- Five tables, no behaviour yet (ingestion + matching come in later
-- phases). Design notes that matter:
--
--   • Scope is per-PROJECT. A `people` row belongs to one project;
--     two projects never share a person. `user_id` is denormalised
--     onto every table purely for RLS owner-only policies (same
--     pattern the rest of the schema uses) — auth.uid() must match.
--
--   • The whole cross-device / cross-platform bridge lives in
--     `people_identifiers`: MANY identifier rows → ONE person. Phone
--     and PC each drop their own rows; they collapse onto the same
--     person the moment a shared identifier (email, sdk_token, login
--     user_id) appears. Columns-per-source would cap at one id and
--     break the instant someone has two devices — rows don't.
--
--   • `people_events.source_event_id` + its UNIQUE constraint is the
--     IDEMPOTENCY SPINE. Every ingest is `ON CONFLICT DO NOTHING`, so
--     re-syncing the same data (overlapping cursor windows, push+poll
--     both firing) is a physical no-op. This is what lets sync be
--     deliberately conservative — re-read rather than risk skipping —
--     at zero cost. The platform's own event id is preferred; when a
--     platform (e.g. GA) gives none, the ingestion layer MUST
--     synthesise a deterministic id (hash of person+event+ts+key
--     props) so the column is never null and the guarantee holds.
--
--   • `event_definitions.tracked` is the volume valve. We only
--     persist `people_events` for definitions the user has opted into
--     (PostHog / GA selection UI, a later phase). Stripe-style
--     low-volume sources can default everything to tracked.
--
--   • `connection_sync_state` is per-connection bookkeeping: an
--     opaque `cursor` so syncs resume instead of refetching, plus
--     `last_event_at` for the freshness watchdog that catches a
--     silently-deleted HogFunction (polling still covers it; the
--     watchdog just flags the staleness).
--
-- Safe to run once on an existing database. Idempotent-ish: uses
-- `IF NOT EXISTS` so re-running doesn't error on the tables, though
-- it won't retro-alter columns.

-- ── people ──────────────────────────────────────────────────────
-- One row per real end-user (a customer's customer), scoped to a
-- project. `primary_email` is denormalised off the identifiers for
-- fast display + as the most common match key; it's a convenience
-- mirror, the authoritative emails live as `people_identifiers`
-- rows with source = 'email'.
CREATE TABLE IF NOT EXISTS people (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,
  primary_email TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_project_id ON people(project_id);
CREATE INDEX IF NOT EXISTS idx_people_user_id    ON people(user_id);
-- Match-by-email lookup during bridging. Partial (email present) keeps
-- the index small — people with no known email never sit in it.
CREATE INDEX IF NOT EXISTS idx_people_project_email
  ON people(project_id, primary_email)
  WHERE primary_email IS NOT NULL;

CREATE TRIGGER people_set_updated_at
  BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── people_identifiers ──────────────────────────────────────────
-- The many IDs that resolve to one person. `source` names the kind
-- ('posthog' | 'ga' | 'stripe' | 'email' | 'sdk_token' | 'device' |
-- app 'user_id' …). `connection_id` records WHICH connection observed
-- it — nullable because global identifiers (email, sdk_token) aren't
-- tied to a single connection.
--
-- UNIQUE (project_id, source, external_id): within a project, a given
-- identifier maps to exactly one person. This is what makes bridging
-- an UPSERT — an incoming id that already exists attaches to its
-- existing person instead of spawning a duplicate.
CREATE TABLE IF NOT EXISTS people_identifiers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT people_identifiers_unique UNIQUE (project_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_people_identifiers_person_id  ON people_identifiers(person_id);
CREATE INDEX IF NOT EXISTS idx_people_identifiers_user_id    ON people_identifiers(user_id);
CREATE INDEX IF NOT EXISTS idx_people_identifiers_connection ON people_identifiers(connection_id);
-- Reverse lookup used by matching: "does this incoming id already
-- belong to someone?" Covered by the UNIQUE constraint's index, but
-- spelled out for the common (source, external_id) probe within a
-- project — same columns, so the UNIQUE index already serves it.

-- ── event_definitions ───────────────────────────────────────────
-- Catalog of event TYPES (PostHog "event definitions"). One row per
-- distinct event_key per connection. `tracked` gates whether we
-- persist occurrences into `people_events`. `display_name` is the
-- human label for the selection UI.
CREATE TABLE IF NOT EXISTS event_definitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  display_name  TEXT,
  tracked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_definitions_unique UNIQUE (connection_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_event_definitions_project ON event_definitions(project_id);
CREATE INDEX IF NOT EXISTS idx_event_definitions_user_id ON event_definitions(user_id);
-- "Which definitions are we actually ingesting for this project?"
CREATE INDEX IF NOT EXISTS idx_event_definitions_tracked
  ON event_definitions(project_id, tracked)
  WHERE tracked = TRUE;

CREATE TRIGGER event_definitions_set_updated_at
  BEFORE UPDATE ON event_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── people_events ───────────────────────────────────────────────
-- Event occurrences. The only table that grows large. `occurred_at`
-- is the event's real timestamp (platform-supplied); `created_at` is
-- our ingest time (useful for debugging sync lag).
--
-- `source_event_id` is the platform's own unique id for the event —
-- the IDEMPOTENCY KEY. When a platform supplies none, ingestion
-- synthesises a deterministic one; the column is therefore NOT NULL.
-- UNIQUE (connection_id, source_event_id) + ON CONFLICT DO NOTHING
-- makes every insert safely re-runnable: push + poll overlap, and
-- conservative re-read windows, can never double-append.
CREATE TABLE IF NOT EXISTS people_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_id           UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  event_definition_id UUID NOT NULL REFERENCES event_definitions(id) ON DELETE CASCADE,
  connection_id       UUID REFERENCES connections(id) ON DELETE SET NULL,
  source_event_id     TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  properties          JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT people_events_idempotent UNIQUE (connection_id, source_event_id)
);

-- Per-person timeline (a person's journey, newest-first scans).
CREATE INDEX IF NOT EXISTS idx_people_events_person_time
  ON people_events(person_id, occurred_at DESC);
-- Funnel / cohort scans: "everyone who did definition X in window".
CREATE INDEX IF NOT EXISTS idx_people_events_project_def_time
  ON people_events(project_id, event_definition_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_people_events_user_id ON people_events(user_id);

-- ── connection_sync_state ───────────────────────────────────────
-- One row per connection we ingest from. `cursor` is opaque per
-- platform (a timestamp, an offset token, a HogQL watermark — the
-- ingestion code owns its meaning). `last_event_at` powers the
-- freshness watchdog. `last_status` / `last_error` surface sync
-- health without a separate logs table.
CREATE TABLE IF NOT EXISTS connection_sync_state (
  connection_id  UUID PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cursor         TEXT,
  last_synced_at TIMESTAMPTZ,
  last_event_at  TIMESTAMPTZ,
  last_status    TEXT,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connection_sync_state_user_id ON connection_sync_state(user_id);

CREATE TRIGGER connection_sync_state_set_updated_at
  BEFORE UPDATE ON connection_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row Level Security ──────────────────────────────────────────
-- Owner-only, identical to every other table. The backend uses the
-- service-role key (bypasses RLS); these policies protect any
-- direct-from-client access path that might exist later.
ALTER TABLE people                ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_identifiers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_definitions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "people_owner_only"                ON people                FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "people_identifiers_owner_only"    ON people_identifiers    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "event_definitions_owner_only"     ON event_definitions     FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "people_events_owner_only"         ON people_events         FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "connection_sync_state_owner_only" ON connection_sync_state FOR ALL USING (auth.uid() = user_id);
