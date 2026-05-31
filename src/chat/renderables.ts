/**
 * Renderable derivation for the Ask-AI chat — turns a successful
 * tool result into a small visual the frontend can render inline
 * below the assistant's text reply.
 *
 * Why split this out of `tools.ts`:
 *   - Tools are data-fetching. They return raw shapes — cents, ISO
 *     dates, server-defined enums. Tools shouldn't know that the
 *     frontend renders charts.
 *   - Frontend shouldn't know that "stripe_gross is in cents" or
 *     "ga_users_today is a string" — that's a *backend* fact.
 *   - This file is the seam: read raw tool I/O, emit a clean
 *     Renderable the frontend can display verbatim (values already
 *     formatted, ranges already string-ified).
 *
 * Adding support for a new tool = add one branch to
 * `maybeRenderableFor` + one builder. Returning `null` means "this
 * call doesn't deserve a visual" — totally valid (most `list_*`
 * tools fall into that bucket).
 */

export type Renderable =
  | StatRenderable
  | ChartRenderable
  | TopListRenderable

export interface StatRenderable {
  kind: 'stat'
  /** Human label, e.g. "MRR" or "Pageviews". */
  label: string
  /** Pre-formatted value, e.g. "$1,234.56" or "5,892". */
  value: string
  /** Optional context — date range, source connection name, etc. */
  sublabel?: string
}

export interface ChartRenderable {
  kind: 'chart'
  title: string
  sublabel?: string
  /**
   * Series points already in display units — currency series here
   * carry DOLLARS, not cents. Frontend just plots numbers.
   */
  series: { label: string; value: number }[]
  /** Hint for axis / tooltip formatting. */
  unit?: 'currency' | 'count' | 'rate'
}

export interface TopListRenderable {
  kind: 'top_list'
  title: string
  sublabel?: string
  rows: { label: string; value: string }[]
}

// ── Public entry point ────────────────────────────────────────────

/**
 * Per-turn context the chat service passes in so renderables can
 * disambiguate parallel cards. Without this, a "how's revenue?"
 * question that hits both projects produces two charts titled
 * "Gross volume this week" — visually indistinguishable. With this,
 * they become "Gross volume this week · Databerry" / "· Taplaunch".
 */
export interface RenderableCtx {
  /**
   * Map of connection id → display info. `projectName` is `null` for
   * "Common" connections (shared across projects) or when the
   * connection's project couldn't be resolved.
   */
  connectionsById: Map<string, { name: string; projectName: string | null }>
}

export function maybeRenderableFor(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  switch (toolName) {
    case 'get_stripe_metric':
      return stripeMetricRenderable(input, result, ctx)
    case 'get_stripe_chart':
      return stripeChartRenderable(input, result, ctx)
    case 'get_stripe_top_customers':
      return stripeTopCustomersRenderable(input, result, ctx)
    case 'get_posthog_event_count':
      return posthogEventCountRenderable(input, result, ctx)
    case 'get_ga_metric':
      return gaMetricRenderable(input, result, ctx)
    // `list_*`, `get_calendly_meetings`, MCP tools: no auto-renderable.
    // MCP tool results have no shared shape, so V1 lets the model
    // narrate them in text. The user can always read the trace popover
    // for the raw tool result.
    default:
      return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function fmtCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function fmtInteger(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Build a "May 25 → May 31" style sublabel from a tool input's
 * `dateFrom`/`dateTo`. Returns undefined when neither is present so
 * the caller can omit the sublabel cleanly.
 */
function fmtRange(input: Record<string, unknown>): string | undefined {
  const from = input.dateFrom
  const to = input.dateTo
  if (typeof from === 'string' && typeof to === 'string' && from && to) {
    return from === to ? from : `${from} → ${to}`
  }
  if (typeof from === 'string' && from) return `from ${from}`
  if (typeof to === 'string' && to) return `through ${to}`
  return undefined
}

/**
 * Resolve a display name for the connection a tool was called
 * against. Prefers the project name (more meaningful for the user —
 * "Databerry" vs. "Stripe on Databerry"), falls back to the
 * connection's own name when the connection is Common, and returns
 * undefined when neither is available.
 */
function fmtSource(
  input: Record<string, unknown>,
  ctx: RenderableCtx,
): string | undefined {
  const id = input.connectionId
  if (typeof id !== 'string' || !id) return undefined
  const conn = ctx.connectionsById.get(id)
  if (!conn) return undefined
  return conn.projectName ?? conn.name ?? undefined
}

/**
 * "{baseTitle} · {source}" when we know the source, else just
 * `baseTitle`. The middle-dot is unicode `·` (U+00B7) — visually
 * lighter than `-`, the standard tagline separator in product UI.
 */
function withSource(baseTitle: string, source: string | undefined): string {
  return source ? `${baseTitle} · ${source}` : baseTitle
}

// ── Stripe ────────────────────────────────────────────────────────

const STRIPE_CURRENCY_METRICS = new Set([
  'stripe_gross_today',
  'stripe_gross',
  'stripe_gross_week',
  'stripe_mrr',
])

function stripeUnit(metric: string): 'currency' | 'count' | 'rate' {
  if (STRIPE_CURRENCY_METRICS.has(metric)) return 'currency'
  if (metric === 'stripe_churn_rate') return 'rate'
  return 'count'
}

const STRIPE_LABELS: Record<string, string> = {
  stripe_gross_today: 'Gross volume today',
  stripe_gross: 'Gross volume',
  stripe_gross_week: 'Gross volume this week',
  stripe_mrr: 'MRR',
  stripe_active_subs: 'Active subscriptions',
  stripe_churn_rate: 'Churn rate',
}

function stripeLabel(metric: string): string {
  return STRIPE_LABELS[metric] ?? metric
}

function fmtStripeScalar(rawValue: unknown, metric: string): string {
  const num = typeof rawValue === 'number' ? rawValue : Number(rawValue)
  if (Number.isNaN(num)) return String(rawValue)
  const unit = stripeUnit(metric)
  if (unit === 'currency') return fmtCents(num)
  if (unit === 'rate') return `${(num * 100).toFixed(1)}%`
  return fmtInteger(num)
}

function stripeMetricRenderable(
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  const r = result as {
    metric?: string
    value?: string | number | null
    unavailable?: boolean
  } | null
  if (!r || r.unavailable || r.value == null || !r.metric) return null
  return {
    kind: 'stat',
    label: withSource(stripeLabel(r.metric), fmtSource(input, ctx)),
    value: fmtStripeScalar(r.value, r.metric),
    sublabel: fmtRange(input),
  }
}

function stripeChartRenderable(
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  const r = result as {
    metric?: string
    mode?: string
    points?: { label: string; value: number }[]
  } | null
  if (!r?.metric || !r.points || r.points.length === 0) return null
  const unit = stripeUnit(r.metric)
  // Cent → dollar conversion happens HERE, not on the frontend.
  // Frontend just plots the numbers it gets.
  const series =
    unit === 'currency'
      ? r.points.map(p => ({ label: p.label, value: p.value / 100 }))
      : r.points
  return {
    kind: 'chart',
    title: withSource(stripeLabel(r.metric), fmtSource(input, ctx)),
    sublabel: fmtRange(input),
    series,
    unit,
  }
}

function stripeTopCustomersRenderable(
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  const r = result as {
    customers?: Array<{ name: string | null; amount: number; charges: number }>
  } | null
  const customers = r?.customers
  if (!customers || customers.length === 0) return null
  return {
    kind: 'top_list',
    title: withSource('Top customers', fmtSource(input, ctx)),
    sublabel: fmtRange(input),
    // Cap at 8 — fits in a single visible block without scrolling on
    // mobile; matches the rough "feels like a top list" mental model.
    rows: customers.slice(0, 8).map(c => ({
      label: c.name ?? '(no name)',
      value: fmtCents(c.amount),
    })),
  }
}

// ── PostHog ───────────────────────────────────────────────────────

function posthogEventCountRenderable(
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  const r = result as {
    total?: number
    buckets?: { date: string; count: number }[]
  } | null
  if (!r) return null
  const eventName = typeof input.eventName === 'string' ? input.eventName : 'event'
  const source = fmtSource(input, ctx)

  // Prefer the time-series view when there are multiple buckets — a
  // trend chart is far more useful than a flat number. Single-bucket
  // (or no-bucket) responses fall back to a stat card.
  if (r.buckets && r.buckets.length > 1) {
    return {
      kind: 'chart',
      title: withSource(`\`${eventName}\` count`, source),
      sublabel: fmtRange(input),
      series: r.buckets.map(b => ({ label: b.date, value: b.count })),
      unit: 'count',
    }
  }
  if (r.total != null) {
    return {
      kind: 'stat',
      label: withSource(`\`${eventName}\` count`, source),
      value: fmtInteger(r.total),
      sublabel: fmtRange(input),
    }
  }
  return null
}

// ── Google Analytics ──────────────────────────────────────────────

const GA_LABELS: Record<string, string> = {
  ga_active_users: 'Active users (live)',
  ga_users_today: 'Users',
  ga_sessions_today: 'Sessions',
  ga_pageviews_today: 'Pageviews',
}

function gaMetricRenderable(
  input: Record<string, unknown>,
  result: unknown,
  ctx: RenderableCtx,
): Renderable | null {
  const r = result as {
    viewType?: string
    value?: string | null
    unavailable?: boolean
  } | null
  if (!r || r.unavailable || r.value == null || !r.viewType) return null
  const num = Number(r.value)
  const display = Number.isNaN(num) ? r.value : fmtInteger(num)
  return {
    kind: 'stat',
    label: withSource(GA_LABELS[r.viewType] ?? r.viewType, fmtSource(input, ctx)),
    value: display,
    sublabel: fmtRange(input),
  }
}
