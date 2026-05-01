import { Logger } from '@nestjs/common'
import {
  escapeDateLiteral,
  escapeStringLiteral,
  tzDateBucket,
  tzWrappedTimestamp,
} from './hogql-utils'
import type { PosthogCredentials } from '../../connection/credentials'

export interface FunnelStepConfig {
  /** Event name as it appears in PostHog. Comes from the picker, which is
   *  in turn populated from PostHog's `/event_definitions/` endpoint — so
   *  the value is constrained at source. We still escape single quotes
   *  defensively (matches the rest of the PostHog HogQL helpers). */
  eventName: string
}

export interface FunnelStepRow {
  /** Step label = the event name. The frontend may rename it, but the
   *  backend always echoes the source event so the row stays auditable. */
  name: string
  /** Distinct users who reached this step (cumulative — anyone who hit
   *  step N also hit steps 1..N-1 within the conversion window). */
  count: number
  /** % of step-1 users who reached this step. 1.0 for step 1, monotonic
   *  non-increasing thereafter. */
  conversionFromStart: number
  /** % of users who progressed from the previous step. 1.0 for step 1,
   *  always between 0 and 1 elsewhere. */
  conversionFromPrev: number
}

/**
 * Build the HogQL for a funnel using ClickHouse's `windowFunnel` aggregate.
 *
 * `windowFunnel(window)(timestamp, cond1, cond2, ...)` returns the deepest
 * step a user (here: `person_id`) hit *in order* within `window` seconds.
 * Wrapping it in `SELECT step, count() ... GROUP BY step` gives us a
 * histogram of "users who got to step N (and stopped there)". We cumulate
 * those counts in JS afterwards so step N = users who reached *at least* N.
 *
 * The `person_id` group key matches the existing PostHog-views convention —
 * `distinct_id` aliases through `person_id` once people are identified, and
 * Posthog's UI does the same.
 *
 * Two HogQL/ClickHouse quirks force the casts below:
 *   1. PostHog's `events.timestamp` is `DateTime64(6, 'UTC')`, which
 *      `windowFunnel` rejects ("Illegal type DateTime64(6, 'UTC') of first
 *      argument…"). We cast to plain `DateTime` first.
 *   2. HogQL's `toDate` is single-arg only. To honour a per-user `tz` for
 *      day-bucketing we wrap with `toTimeZone(timestamp, tz)` before
 *      truncating — same pattern as `sources.ts` uses post-fix.
 *
 * Splitting the build out as a pure function keeps the SQL unit-testable
 * without I/O — same trick as `mrr.helper.ts` on the Stripe side.
 */
export function buildFunnelHogql(
  steps: FunnelStepConfig[],
  conversionWindowSeconds: number,
  dateFrom: string,
  dateTo: string,
  tz: string = 'UTC',
): string {
  const safeFrom = escapeDateLiteral(dateFrom)
  const safeTo = escapeDateLiteral(dateTo)
  const safeWindow = Math.max(1, Math.floor(conversionWindowSeconds))
  const stepConds = steps
    .map(s => `event = '${escapeStringLiteral(s.eventName)}'`)
    .join(', ')

  // Build once — interpolated in two places below.
  const tzTs = tzWrappedTimestamp(tz)
  const tzDate = tzDateBucket(tz)

  // Parens around BETWEEN are load-bearing — HogQL's AND binds tighter
  // than BETWEEN, so without them the parser reads
  // `(event = X AND toDate(timestamp)) BETWEEN …` and crashes on the
  // string-AND-Date type mismatch. `toDateTime(...)` fixes windowFunnel's
  // refusal of `DateTime64`.
  return `SELECT step, count() FROM (SELECT person_id, windowFunnel(${safeWindow})(toDateTime(${tzTs}), ${stepConds}) AS step FROM events WHERE (${tzDate} BETWEEN toDate('${safeFrom}') AND toDate('${safeTo}')) GROUP BY person_id) WHERE step > 0 GROUP BY step ORDER BY step`
}

/**
 * Run a windowFunnel HogQL query and return the cumulative per-step result.
 *
 * Posthog returns rows like `[step, count]` where `step` is the deepest
 * step each user reached. We bucket them, then cumulate from the deepest
 * back so `out[i]` = "users who hit at least step i+1". This is the shape
 * the funnel card renders directly.
 */
export async function fetchPosthogFunnel(
  ph: PosthogCredentials,
  steps: FunnelStepConfig[],
  conversionWindowSeconds: number,
  dateFrom: string,
  dateTo: string,
  logger: Logger,
  tz: string = 'UTC',
): Promise<{ steps: FunnelStepRow[] }> {
  if (steps.length < 2) {
    // Two-step minimum is enforced in the picker; this is a safety net so a
    // bad config doesn't fire a malformed HogQL query at PostHog.
    return { steps: [] }
  }

  const hogql = buildFunnelHogql(steps, conversionWindowSeconds, dateFrom, dateTo, tz)
  logger.log(`  → posthog funnel HogQL: ${hogql}`)

  const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ph.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error(`PostHog funnel query failed: ${body}`)
    return { steps: [] }
  }

  const json = (await res.json()) as { results?: [number, number][] }

  // `results` is a histogram of *deepest step reached*. Bucket into a fixed
  // array sized to `steps.length`, then cumulate from the right so each
  // entry is "users who reached at least this step".
  const histogram = new Array<number>(steps.length).fill(0)
  for (const [stepIdx, count] of json.results ?? []) {
    const i = Math.max(0, Math.min(steps.length - 1, Number(stepIdx) - 1))
    histogram[i] = (histogram[i] ?? 0) + (Number(count) || 0)
  }
  const cumulative = new Array<number>(steps.length).fill(0)
  // Walk right-to-left: anyone who reached step k also reached k-1, k-2, ..., 0.
  for (let i = steps.length - 1; i >= 0; i--) {
    cumulative[i] = histogram[i] + (i + 1 < steps.length ? cumulative[i + 1] : 0)
  }

  const startCount = cumulative[0] || 0
  const rows: FunnelStepRow[] = steps.map((s, i) => {
    const count = cumulative[i]
    const prev = i === 0 ? count : cumulative[i - 1]
    return {
      name: s.eventName,
      count,
      conversionFromStart: startCount > 0 ? count / startCount : 0,
      conversionFromPrev: prev > 0 ? count / prev : 0,
    }
  })

  return { steps: rows }
}
