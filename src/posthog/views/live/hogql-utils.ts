/**
 * Tiny utilities for safely composing HogQL strings.
 *
 * PostHog's HogQL is a subset of ClickHouse SQL with a few quirks
 * (single-arg `toDate`, `toTimeZone` is the canonical name, etc.). We
 * never run untrusted SQL — every value-tile builder lives in this
 * codebase — but we do interpolate user-provided strings (event names,
 * date strings, tz). These helpers centralise the escaping rules and
 * the "wrap timestamp in the user's tz before truncating" idiom that
 * appears in every HogQL builder.
 *
 * Lifted out of `funnel.ts` / `retention.ts` / `users.ts` / `sources.ts`
 * which previously each inlined the same `replace(/'/g, '')` + `tzLit`
 * recipe.
 */

import { safeTzLiteral } from '../../../common/tz'

/**
 * Strip single quotes from a date-like literal. Date strings come from
 * our own controllers and are pre-validated against the YYYY-MM-DD
 * shape, but we still scrub quotes defensively before injecting into a
 * literal — defense in depth.
 *
 * `'2024-01-15'` → stays `'2024-01-15'` (no quotes to strip)
 * `"2024'or'1=1"` → `2024or1=1` (any embedded quotes are removed)
 */
export function escapeDateLiteral(s: string): string {
  return s.replace(/'/g, '')
}

/**
 * Escape a single-quoted HogQL string literal — backslash-escapes any
 * `'` so we can interpolate event names, source domains, etc. without
 * breaking the surrounding `'…'` quotes. Mirrors ClickHouse's own
 * single-quote escaping rule.
 *
 * `O'Brien` → `O\'Brien`
 */
export function escapeStringLiteral(s: string): string {
  return s.replace(/'/g, "\\'")
}

/**
 * `toTimeZone(timestamp, '<tz>')` expression — the canonical way to
 * shift the `events.timestamp` column into a user-local clock before
 * any date/time truncation (`toDate`, `toStartOfHour`, `toMonday`).
 *
 * Two HogQL gotchas this hides:
 *   - `toDate` is single-arg in HogQL (the 2-arg ClickHouse form
 *     `toDate(ts, 'tz')` is rejected) — wrap with `toTimeZone` first,
 *     truncate second.
 *   - The function is `toTimeZone` (capital Z); `toTimezone` is
 *     rejected with "Unsupported function call".
 *
 * `tz` is sanitized via `safeTzLiteral` — non-IANA inputs collapse to
 * `'UTC'`, so injection bait can't ride through here.
 */
export function tzWrappedTimestamp(tz: string, column: string = 'timestamp'): string {
  const tzLit = safeTzLiteral(tz)
  return `toTimeZone(${column}, '${tzLit}')`
}

/**
 * `toDate(toTimeZone(timestamp, '<tz>'))` — day bucket in the user's tz.
 * Use this anywhere you previously had `toDate(timestamp)` and want
 * day-of-month boundaries to align with the user's wall clock.
 */
export function tzDateBucket(tz: string, column: string = 'timestamp'): string {
  return `toDate(${tzWrappedTimestamp(tz, column)})`
}

/**
 * Canonical first-touch traffic-source expression — the SINGLE source of
 * truth for how every PostHog surface attributes a visit to a source.
 * Used by the overview chart's stacked bars + the Sources panel
 * (`sources.ts`) and the per-user list (`users.ts`), so they can never
 * drift apart on what counts as e.g. Product Hunt vs "direct".
 *
 * Precedence (first non-empty wins):
 *   1. `?ref=<x>` from the LANDING URL — explicit campaign tag used by
 *      directories / launch platforms (Product Hunt sends
 *      `?ref=producthunt`; many others use `?ref=`). PostHog does NOT
 *      auto-capture `ref` into a property — it only captures `utm_*`,
 *      gclid, fbclid, … — but the full landing URL is preserved in
 *      `$initial_current_url`, so we pull `ref` back out of it with
 *      `extractURLParameter`. This is RETROACTIVE: a visit that landed on
 *      `…/?ref=producthunt` with no HTTP referrer was previously bucketed
 *      as "direct"; reading the ref from the stored URL re-attributes it
 *      to its real source with no data loss.
 *   2. `utm_source` — the standard campaign param (PostHog captures this
 *      natively as `$initial_utm_source`).
 *   3. `$initial_referring_domain` — first-touch HTTP referrer; the
 *      previous sole signal, still the fallback for untagged referrals.
 *
 * Property path: `$initial_*` are PERSON properties. HogQL exposes them
 * as `person.properties.$initial_*` (persons-on-events). We still
 * coalesce the legacy `properties.$initial_*` path — some PostHog
 * projects / query modes surface them there, and keeping both means
 * PH `ref=` recovery works without breaking projects that already
 * attributed google/reddit via the event-properties path.
 *
 * `nullIf(x, '')` turns empties into NULL so `coalesce` skips them — an
 * untagged visit falls straight through to the referrer and behaves
 * exactly as before (no regression for existing sources).
 *
 * Callers that GROUP BY a per-user/per-session key wrap this in an
 * aggregate, e.g. `any(${POSTHOG_SOURCE_EXPR})`.
 */
export const POSTHOG_SOURCE_EXPR =
  `coalesce(` +
  `nullIf(extractURLParameter(person.properties.$initial_current_url, 'ref'), ''), ` +
  `nullIf(extractURLParameter(properties.$initial_current_url, 'ref'), ''), ` +
  `nullIf(person.properties.$initial_utm_source, ''), ` +
  `nullIf(properties.$initial_utm_source, ''), ` +
  `nullIf(person.properties.$initial_referring_domain, ''), ` +
  `properties.$initial_referring_domain)`
