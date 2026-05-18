/**
 * Tiny formatters for the NestJS Logger so every service emits the
 * same log shape — same prefixes, same `key=value` context format,
 * same response-body truncation. Cuts the cognitive cost of reading
 * the backend's logs in production where a 5KB JSON dump from an
 * upstream API ruins both Railway's log viewer and your ability to
 * scan the line that matters.
 *
 * Existing "good" pattern in the codebase (the one we're standardising):
 *
 *     this.logger.log(`\n  ► fetchCountries  projectId=${id} limit=${n}`)
 *
 * Existing "bad" pattern (what we're replacing):
 *
 *     this.logger.warn('Failed to list GA accounts: ' + await res.text())
 *     this.logger.error('Error listing GA properties', err)
 *
 * Bad pattern problems: no userId/connectionId to trace which user
 * triggered it, no operation name (`Failed:` opaque without naming
 * the action), unbounded response body that buries the next log line.
 *
 * USAGE:
 *
 *     // Info — operation about to run / just ran
 *     logger.log(fmtOp('fetchProperties', { connectionId, userId }))
 *
 *     // Upstream failure (HTTP status + body from the API)
 *     logger.warn(fmtUpstreamFailure(
 *       'list GA accounts', accRes.status, await accRes.text(),
 *       { connectionId, userId },
 *     ))
 *
 *     // Generic failure (caught exception, no upstream status)
 *     logger.error(fmtFailure(
 *       'persist Sentry credentials', err,
 *       { connectionId, userId },
 *     ))
 */

export type LogContext = Record<string, string | number | boolean | undefined | null>

/**
 * Format a context object as space-separated `key=value` pairs.
 * Skips undefined / null / empty-string values so optional ids
 * don't render as `userId=undefined`.
 */
export function fmtCtx(ctx: LogContext): string {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

/**
 * Truncate a long string (typically an upstream API response body
 * or a stack trace) so a single log line never exceeds a few
 * hundred chars. Tail tells the reader how much was dropped so
 * "exact match" debugging knows to grab the full body elsewhere.
 */
export function truncate(s: string, max = 256): string {
  if (s == null) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max)}… (+${s.length - max} more)`
}

/**
 * Standard "operation in flight / completed" info line:
 *
 *     ► <operation>  key1=value1 key2=value2
 *
 * Leading newline + indent matches the existing convention in
 * `project-overview.service.ts` etc.
 */
export function fmtOp(operation: string, ctx: LogContext = {}): string {
  const ctxStr = fmtCtx(ctx)
  return `\n  ► ${operation}${ctxStr ? `  ${ctxStr}` : ''}`
}

/**
 * Standard "upstream API responded non-OK" warn/error line:
 *
 *     ✗ <operation> failed  status=403  connectionId=…  body=<truncated>
 *
 * Use for HTTP-style failures where you have a status code AND a
 * response body. Body is always truncated to keep log lines scannable.
 */
export function fmtUpstreamFailure(
  operation: string,
  status: number,
  body: string,
  ctx: LogContext = {},
): string {
  const ctxStr = fmtCtx(ctx)
  return (
    `\n  ✗ ${operation} failed  status=${status}` +
    `${ctxStr ? `  ${ctxStr}` : ''}` +
    `  body=${truncate(body)}`
  )
}

/**
 * Standard "caught exception" error line — no upstream status code,
 * just an error object/message:
 *
 *     ✗ <operation> errored  connectionId=…  reason=<short message>
 */
export function fmtFailure(
  operation: string,
  err: unknown,
  ctx: LogContext = {},
): string {
  const ctxStr = fmtCtx(ctx)
  const reason =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  return (
    `\n  ✗ ${operation} errored` +
    `${ctxStr ? `  ${ctxStr}` : ''}` +
    `  reason=${truncate(reason, 200)}`
  )
}
