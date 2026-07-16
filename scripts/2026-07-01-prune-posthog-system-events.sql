-- Prune PostHog system events from the people timeline.
--
-- Ingest policy (posthog.sync.ts): keep custom events + `$pageview` only;
-- drop all other `$…` noise ($web_vitals, $autocapture, $pageleave, …).
--
-- This migration removes historical rows that were synced before that filter.
-- Safe to re-run (deletes nothing once junk is gone).
--
-- Preview (run first, no writes):
--
--   SELECT ed.event_key, COUNT(pe.id) AS occurrences
--   FROM event_definitions ed
--   LEFT JOIN people_events pe ON pe.event_definition_id = ed.id
--   WHERE ed.source = 'posthog'
--     AND ed.event_key LIKE '$%'
--     AND ed.event_key <> '$pageview'
--   GROUP BY ed.event_key
--   ORDER BY occurrences DESC;

BEGIN;

-- `people_events.event_definition_id` → ON DELETE CASCADE, so removing the
-- definition rows clears all matching occurrences in one shot.
DELETE FROM event_definitions
WHERE source = 'posthog'
  AND event_key LIKE '$%'
  AND event_key <> '$pageview';

COMMIT;
