import { safeTzLiteral } from './tz'

/**
 * Shared preamble for every per-integration `fetchLiveValue` (Stripe,
 * PostHog, Calendly, GA). Each one used to inline the same recipe:
 *
 *   const todayStr = new Date().toISOString().split('T')[0]
 *   const from = dateFrom ?? todayStr
 *   const to = dateTo ?? from
 *   const isSingleDay = from === to
 *
 * Plus a tz sanitisation pass via `safeTzLiteral`. Centralised here so
 * "what does today mean" / "what's the safe tz" decisions live in one
 * file. Cheap struct, no allocation cost worth talking about.
 */

export interface ViewFetchContext {
  /** YYYY-MM-DD (UTC). Inclusive lower bound. */
  from: string
  /** YYYY-MM-DD (UTC). Inclusive upper bound. */
  to: string
  /** True when the range is a single calendar day. Used to decide
   *  whether to upsert the value into `views_values` for caching — we
   *  only cache single-day reads because the table is keyed by day. */
  isSingleDay: boolean
  /** IANA timezone, sanitized via `safeTzLiteral`. Always a valid
   *  identifier (or `'UTC'` when the input is missing/malformed). */
  tz: string
}

/**
 * Build a `ViewFetchContext` from optional caller inputs. `dateFrom`
 * and `dateTo` come straight from the controller's query string;
 * `tz` from `?tz=` (or null).
 *
 * Defaults:
 *   - `from`: today (UTC)
 *   - `to`:   `from` (single-day fetch)
 *   - `tz`:   `'UTC'` (when omitted or malformed)
 */
export function buildViewFetchContext(
  dateFrom?: string,
  dateTo?: string,
  tz?: string | null,
): ViewFetchContext {
  const todayStr = new Date().toISOString().split('T')[0]
  const from = dateFrom ?? todayStr
  const to = dateTo ?? from
  return {
    from,
    to,
    isSingleDay: from === to,
    tz: safeTzLiteral(tz),
  }
}
