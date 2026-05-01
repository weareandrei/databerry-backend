/**
 * Timezone helpers for chart bucketing.
 *
 * The overview chart used to be UTC end-to-end: backend bucketed by UTC hour,
 * labels were UTC hours, the "Now" line on the frontend was UTC. For a user
 * not on UTC, the chart looked like it was in someone else's timezone — the
 * "Now" line lagged behind their wall clock and ingested events appeared in
 * "future" hours. We now thread the user's IANA timezone (e.g.
 * `Europe/Moscow`, `America/Los_Angeles`) from the frontend through to the
 * SQL aggregation so the chart matches what the user actually expects.
 *
 * Node ≥ 18 ships `Intl.DateTimeFormat` with full IANA tz support, so no
 * library is needed.
 */

export interface ZonedFields {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
}

/**
 * Sanitize an IANA timezone string for safe injection into a HogQL/SQL
 * string literal. IANA names use only `[A-Za-z0-9_/+-]`; anything else
 * (quotes, spaces, control chars) is treated as injection and falls back
 * to UTC.
 *
 * Returns `'UTC'` for `undefined`, `null`, or any non-matching input —
 * the entire codebase treats `'UTC'` as the safe default.
 */
export function safeTzLiteral(tz: string | undefined | null): string {
  return typeof tz === 'string' && /^[A-Za-z0-9_/+-]+$/.test(tz) ? tz : 'UTC'
}

/**
 * Decompose a UTC `Date` into year/month/day/hour as observed in `tz`.
 * Returns hour=0 for midnight (we normalize Intl's "24" edge case).
 */
export function fieldsInTz(date: Date, tz: string): ZonedFields {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find(p => p.type === t)!.value, 10)
  let hour = get('hour')
  if (hour === 24) hour = 0 // some locales render midnight as "24"
  return { year: get('year'), month: get('month'), day: get('day'), hour }
}

/**
 * Returns the UTC instant corresponding to `YYYY-MM-DD 00:00:00` in `tz`.
 *
 * We can't just do `Date.UTC(...) - offsetMs` because tz offsets vary across
 * the year (DST). We compute the offset *at* the target moment by:
 *   1. Treating the input as if it were UTC midnight (a guess).
 *   2. Reading what that UTC instant looks like in `tz`.
 *   3. Computing the delta and shifting the guess by it.
 * One pass is enough for any tz that doesn't transition during a one-hour
 * window around midnight (DST jumps happen at 2-3am in most zones, so
 * single-pass is correct in practice).
 */
export function localMidnightUtc(yyyymmdd: string, tz: string): Date {
  const [yStr, mStr, dStr] = yyyymmdd.split('-')
  const y = parseInt(yStr, 10)
  const m = parseInt(mStr, 10)
  const d = parseInt(dStr, 10)

  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
  const seen = fieldsInTz(guess, tz)
  // What the guess's UTC milliseconds-since-epoch would be if you read
  // the *zoned* fields back as if they were UTC.
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour)
  // Offset between the zoned reading and the UTC reading at this moment.
  const offsetMs = seenAsUtc - guess.getTime()
  return new Date(guess.getTime() - offsetMs)
}

/** "YYYY-MM-DD" of `date` as observed in `tz`. */
export function dateStrInTz(date: Date, tz: string): string {
  const f = fieldsInTz(date, tz)
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)}`
}

/** "YYYYMMDDHH" of `date` as observed in `tz` (matches GA `dateHour`). */
export function gaDateHourKeyInTz(date: Date, tz: string): string {
  const f = fieldsInTz(date, tz)
  return `${f.year}${pad2(f.month)}${pad2(f.day)}${pad2(f.hour)}`
}

/** "YYYY-MM-DDTHH:00:00" of `date` as observed in `tz` (matches PostHog
 *  `toStartOfHour(toTimeZone(timestamp, tz))` output — `toStartOfHour` is
 *  single-arg in HogQL, so we apply the timezone via `toTimeZone` first.
 *  The returned DateTime renders no tz suffix and uses ISO-style `T`
 *  separator, which this key generator mirrors verbatim. */
export function phHourlyKeyInTz(date: Date, tz: string): string {
  const f = fieldsInTz(date, tz)
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)}T${pad2(f.hour)}:00:00`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
