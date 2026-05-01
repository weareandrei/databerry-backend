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
