-- Add per-container ordering to `views`.
--
-- Backs drag-and-drop reorder. Order is scoped to a (project_id,
-- folder_id) container; the composite project_overview pair is pinned
-- to the top at the application layer (not enforced here).
--
-- Run once in Supabase Studio → SQL editor. Idempotent (re-runnable).
--
-- Null-position is treated as a VALID fallback state — the backend
-- orders by `position NULLS LAST, created_at, id`, so any view that
-- ends up without a position (legacy data, partial migration, future
-- insert path missing the explicit write) lands at the END of its
-- container in creation order. The user can then drag it to reorder,
-- which writes a real position. Deliberately NOT NULL-constrained so
-- those fallbacks never become a schema violation.
--
-- `"position"` is quoted defensively — it's a recognised SQL keyword
-- (`POSITION(... IN ...)` function). Usable unquoted in Postgres, but
-- quoting eliminates parser ambiguity. The backend code uses
-- `position` unquoted; both forms resolve to the same lowercase column.

-- 1. Add the column. Stays nullable on purpose — see header.
ALTER TABLE views ADD COLUMN IF NOT EXISTS "position" INTEGER;

-- 2. Backfill: assign 0..N-1 within each (project_id, folder_id)
--    bucket ordered by created_at — the same order the dashboard
--    rendered with today, so nothing visibly moves after this
--    migration. Only fills NULLs, so a re-run after partial deploy
--    won't clobber positions the application has already written.
UPDATE views v
SET "position" = sub.pos
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY project_id, folder_id
    ORDER BY created_at ASC, id ASC
  ) - 1 AS pos
  FROM views
  WHERE "position" IS NULL
) sub
WHERE v.id = sub.id;

-- 3. Sort index. NOT a UNIQUE constraint — the reorder endpoint
--    batch-updates positions and a unique constraint would require a
--    two-phase swap or DEFERRABLE handling. Duplicates are tolerated;
--    secondary sort by created_at + id keeps reads deterministic if
--    they ever occur.
CREATE INDEX IF NOT EXISTS idx_views_container_position
  ON views (project_id, folder_id, "position");

-- ── Verification (run separately if you want to confirm) ────────────
-- SELECT COUNT(*) FILTER (WHERE "position" IS NULL) AS unfilled,
--        COUNT(*) AS total
-- FROM views;
--
-- After this migration: unfilled = 0 (everything backfilled). Going
-- forward: unfilled may transiently rise if any insert path skips the
-- explicit write; those rows still render correctly via the sort
-- fallback.
