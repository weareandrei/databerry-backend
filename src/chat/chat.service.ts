/**
 * Ask-AI agentic loop, server-side.
 *
 * - One chat turn = N agent iterations (capped at MAX_AGENT_TURNS)
 *   inside `runAgent`. Each iteration sends the message log + tool
 *   list to Claude; if Claude responds with `tool_use`, we execute
 *   each tool against our own services (no HTTP), feed results
 *   back, and loop.
 * - Inventory (`list_projects`, `list_connections`) is pre-loaded
 *   into the system prompt at the start of each turn so the model
 *   sees the user's data inventory without spending an extra round
 *   trip on every question.
 * - Tools are called *in-process* via injected services. Per-user
 *   scoping is preserved because each handler receives the auth
 *   user id and the underlying services already filter by user.
 *
 * No DB persistence. The client owns the message log (in
 * localStorage); the server is stateless per request.
 */

import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'
import { ProjectsService } from '../projects/projects.service'
import { ConnectionsService } from '../connections/connections.service'
import { StripeViewsService } from '../stripe/views/views.service'
import { CalendlyViewsService } from '../calendly/views/views.service'
import { PosthogViewsService } from '../posthog/views/views.service'
import { GoogleAnalyticsViewsService } from '../google-analytics/views/views.service'
import { McpService } from '../mcp/mcp.service'
import { buildTools, type ChatTool, type ToolCtx, type ToolDeps } from './tools'
import {
  maybeRenderableFor,
  type Renderable,
  type RenderableCtx,
} from './renderables'

// Sonnet 4.5 instead of Opus 4.5: ~5× cheaper across input + output
// tokens, still extremely capable at tool-using chat. Opus is overkill
// for "answer a question about your Stripe MRR" — Sonnet handles
// multi-tool reasoning fine. Bump to Opus only if we see Sonnet
// missing tool calls or producing worse summaries.
const MODEL = 'claude-sonnet-4-5'
const MAX_AGENT_TURNS = 5

// Cap on auto-generated visual cards per chat turn. The agent can
// call many tools in a single turn ("Are we doing good?" → revenue
// + MRR + active subs + recent activity); without a cap we'd render
// six cards under one reply, which gets visually crowded. Four leaves
// room for the model to surface the most useful primaries without
// turning the surface into a dashboard. Built-in tools whose results
// don't deserve a card (`list_*`, MCP tools today) don't count
// against this limit anyway.
const MAX_RENDERABLES_PER_TURN = 4

// ── Date context for the system prompt ─────────────────────────────
//
// The model's training cutoff is months or years before the current
// wall clock, and the system prompt gives it the user's timezone but
// no anchor for "what is today's date." Left to its own devices it
// fills in dates from its prior — e.g. assumes "this week" means
// some week in early 2025 — and passes that range to a metric tool,
// which then dutifully returns $0 because the user wasn't charging
// anything back then.
//
// Fix: compute today's date IN THE USER'S TIMEZONE plus the obvious
// relative-date anchors ("this week", "last week", etc.) and inject
// them as a block. The model only has to substitute, not compute.
//
// We do the date math via `Intl.DateTimeFormat` (which honours
// `timeZone`) to get the wall-clock Y/M/D in the user's tz, then
// shift forward/backward in pure UTC date arithmetic. Date-only
// math is DST-safe because we never carry a time-of-day component.

interface YmdParts {
  year: number
  month: number // 1-12
  day: number
  weekday: string // 'Monday' | 'Tuesday' | …
}

/** Format Y/M/D/weekday of `instant` rendered in `tz`. */
function getWallClock(instant: Date, tz: string): YmdParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(instant)
  const get = (type: string) =>
    parts.find(p => p.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  }
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Add `days` to a Y/M/D triple using UTC arithmetic. We're operating
 * on calendar dates, not instants, so UTC-based shifting gives the
 * right answer regardless of the user's timezone or DST transitions.
 */
function addDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  d.setUTCDate(d.getUTCDate() + days)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  }
}

const ISO_WEEKDAY_INDEX: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
}

function buildDateContext(tz: string | null): string {
  // Always run the math with SOME tz — UTC is the safe fallback when
  // the client didn't send one. The output explicitly says "(UTC,
  // user tz unknown)" in that case so the model knows the anchors
  // may be off by a few hours from the user's wall clock.
  const effectiveTz = tz ?? 'UTC'

  const today = getWallClock(new Date(), effectiveTz)
  const todayStr = fmt(today.year, today.month, today.day)

  const dowIdx = ISO_WEEKDAY_INDEX[today.weekday] ?? 0
  const mondayThisWeek = addDays(today, -dowIdx)
  const sundayThisWeek = addDays(mondayThisWeek, 6)
  const mondayLastWeek = addDays(mondayThisWeek, -7)
  const sundayLastWeek = addDays(mondayThisWeek, -1)

  // Last day of the current month: day 0 of next month in UTC.
  const monthEnd = new Date(Date.UTC(today.year, today.month, 0))
  const thisMonthStart = fmt(today.year, today.month, 1)
  const thisMonthEnd = fmt(today.year, today.month, monthEnd.getUTCDate())

  // Previous calendar month.
  const prevYear = today.month === 1 ? today.year - 1 : today.year
  const prevMonth = today.month === 1 ? 12 : today.month - 1
  const prevMonthEnd = new Date(Date.UTC(prevYear, prevMonth, 0))
  const lastMonthStart = fmt(prevYear, prevMonth, 1)
  const lastMonthEnd = fmt(prevYear, prevMonth, prevMonthEnd.getUTCDate())

  const tzLabel = tz ?? 'UTC (user tz unknown)'

  return [
    'DATE CONTEXT (use these — do not compute dates from training-data priors):',
    `- Today: ${todayStr} (${today.weekday}) in timezone ${tzLabel}`,
    `- "today" → ${todayStr}`,
    `- "yesterday" → ${(() => {
      const y = addDays(today, -1)
      return fmt(y.year, y.month, y.day)
    })()}`,
    `- "this week" (Mon–Sun) → ${fmt(mondayThisWeek.year, mondayThisWeek.month, mondayThisWeek.day)} to ${fmt(sundayThisWeek.year, sundayThisWeek.month, sundayThisWeek.day)}`,
    `- "last week" (Mon–Sun) → ${fmt(mondayLastWeek.year, mondayLastWeek.month, mondayLastWeek.day)} to ${fmt(sundayLastWeek.year, sundayLastWeek.month, sundayLastWeek.day)}`,
    `- "this month" → ${thisMonthStart} to ${thisMonthEnd}`,
    `- "last month" → ${lastMonthStart} to ${lastMonthEnd}`,
    `- "last 7 days" → ${(() => {
      const s = addDays(today, -6)
      return fmt(s.year, s.month, s.day)
    })()} to ${todayStr}`,
    `- "last 30 days" → ${(() => {
      const s = addDays(today, -29)
      return fmt(s.year, s.month, s.day)
    })()} to ${todayStr}`,
  ].join('\n')
}

export interface ToolCallTrace {
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
  /**
   * Set when the tool came from one of the user's MCP servers (as
   * opposed to a built-in tool like `get_stripe_metric`). Carries
   * the connection's display name + the tool's ORIGINAL (un-
   * namespaced) name so the frontend can render a chip with the
   * MCP name instead of the noisy internal `mcp_0__listPosts` form.
   */
  mcp?: { connectionName: string; toolName: string }
}

export interface ChatRunResult {
  reply: string
  toolCalls: ToolCallTrace[]
  /**
   * Visual cards derived from successful tool results — stat
   * numbers, mini line charts, top-N lists. Rendered by the
   * frontend below the assistant's text bubble. The agent's prose
   * still narrates ("revenue trended up this week"); these are
   * the visual companion.
   *
   * Built by `renderables.ts` per tool — the chat service just
   * collects them. Capped at `MAX_RENDERABLES_PER_TURN` to keep
   * busy turns from drowning the chat surface in cards.
   */
  renderables: Renderable[]
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)
  private readonly anthropic: Anthropic | null
  private readonly tools: Record<string, ChatTool>
  private readonly toolDefinitions: Anthropic.Tool[]

  constructor(
    private readonly projects: ProjectsService,
    private readonly connections: ConnectionsService,
    private readonly stripeViews: StripeViewsService,
    private readonly calendlyViews: CalendlyViewsService,
    private readonly posthogViews: PosthogViewsService,
    private readonly gaViews: GoogleAnalyticsViewsService,
    private readonly mcp: McpService,
  ) {
    // Construct lazily — let the controller surface a clean error if
    // the env var isn't set, instead of crashing at module init time.
    const apiKey = process.env.ANTHROPIC_API_KEY
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null

    const deps: ToolDeps = {
      projects,
      connections,
      stripeViews,
      calendlyViews,
      posthogViews,
      gaViews,
      mcp,
    }
    this.tools = buildTools(deps)
    this.toolDefinitions = Object.values(this.tools).map(t => t.definition)
  }

  isConfigured(): boolean {
    return this.anthropic !== null
  }

  // ── System prompt building ──────────────────────────────────────────────

  private async loadInventory(userId: string): Promise<{
    projects: { id: string; name: string }[]
    connections: { id: string; name: string; type: string; projectId: string | null }[]
  }> {
    // Best-effort — if either call fails we proceed without that
    // half of the inventory rather than blocking the whole chat.
    // The services return `unknown`-typed columns (toCamel mapping
    // doesn't narrow), so we cast here to the shapes we need.
    const [projectsRaw, connectionsRaw] = await Promise.all([
      this.projects.getProjects(userId).catch(err => {
        this.logger.warn(`loadInventory: getProjects failed — ${err.message}`)
        return []
      }),
      this.connections.getConnections(userId).catch(err => {
        this.logger.warn(`loadInventory: getConnections failed — ${err.message}`)
        return []
      }),
    ])
    const projects = (projectsRaw as Array<{ id: unknown; name: unknown }>).map(p => ({
      id: String(p.id),
      name: String(p.name),
    }))
    const connections = (
      connectionsRaw as Array<{ id: unknown; name: unknown; type: unknown; projectId: unknown }>
    ).map(c => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      type: String(c.type),
      projectId: (c.projectId as string | null | undefined) ?? null,
    }))
    return { projects, connections }
  }

  private buildSystemPrompt(
    projects: { id: string; name: string }[],
    connections: { id: string; name: string; type: string; projectId: string | null }[],
    tz: string | null,
    mcpServers: McpServerSummary[],
  ): string {
    const projectLines = projects.length
      ? projects.map(p => `- ${p.id} "${p.name}"`).join('\n')
      : '(none)'

    const projectNameById = new Map(projects.map(p => [p.id, p.name]))
    const connLines = connections.length
      ? connections
          .map(c => {
            const projName = c.projectId
              ? (projectNameById.get(c.projectId) ?? c.projectId)
              : 'unassigned'
            return `- ${c.id} (${c.type}) — project "${projName}"`
          })
          .join('\n')
      : '(none)'

    // MCP servers — only emit a section when the user has any
    // configured. Listing each server's tool names lets the model
    // know "for Beehiiv questions there's a `list_posts` tool" before
    // it scans the tools[] array. Names are the original (server-
    // facing) names; the Anthropic-facing names are `mcp_<idx>__<n>`,
    // documented in the routing guidance below.
    const mcpLines = mcpServers.length
      ? mcpServers
          .map(s => {
            const tools = s.toolNames.slice(0, 12) // cap so the prompt stays bounded
            const more =
              s.toolNames.length > tools.length
                ? ` + ${s.toolNames.length - tools.length} more`
                : ''
            const toolList = tools.length ? tools.join(', ') + more : '(no tools)'
            return `- mcp_${s.idx} "${s.name}" — tools: ${toolList}`
          })
          .join('\n')
      : null

    const sections: string[] = [
      "You are Databerry's data assistant. You help solo founders understand their business by answering questions about the data they've connected.",
      '',
      'The current user has the following projects and connections:',
      '',
      'PROJECTS:',
      projectLines,
      '',
      'CONNECTIONS:',
      connLines,
    ]

    if (mcpLines) {
      sections.push(
        '',
        'MCP SERVERS (third-party tools the user wired up via the Model Context Protocol — each tool below is callable as `mcp_<idx>__<tool>` in the tools[] list):',
        mcpLines,
      )
    }

    sections.push(
      '',
      // CRITICAL: the model's training cutoff is months-to-years
      // before today, so without this block it WILL guess a date
      // from its prior and pass it to a metric tool — leading to
      // wrong "this week" lookups against an empty range. Anchor
      // everything to wall-clock now-in-user-tz here.
      buildDateContext(tz),
      '',
      'Guidelines:',
      "- When the user names a project, look it up in the PROJECTS list above. You don't need to call list_projects unless the inventory above is empty.",
      '- For metric tools (`get_stripe_metric`, `get_stripe_chart`, `get_posthog_event_count`), pass `tz` from the date context above AND derive `dateFrom` / `dateTo` from the anchors above for relative queries ("today", "this week", "last month"). NEVER guess dates from your own training data — your knowledge cutoff is before today.',
      '- Currency values from Stripe tools are in **cents**. Divide by 100 and format as USD when reporting (e.g. `$1,234.56`).',
      '- Cite which connection / project a number came from (e.g. "$1,234 — Stripe on Taplaunch").',
      '- When you mention a date range in your reply, use the SAME range you actually passed to the tool — never paraphrase it into a different year/week.',
      '- Be concise. Markdown is supported (bold, lists, inline code).',
      "- If a tool returns `unavailable: true` or an error, tell the user the data isn't available rather than fabricating numbers.",
      '',
      'Routing — picking the right source for the user\'s question:',
      "- **Revenue / money / sales** → Stripe. If the user names a project, use only that project's Stripe connection. If they don't name one (\"how is my revenue this week?\") and the user has MULTIPLE Stripe connections across projects, query each one and either sum them (one overall figure) OR break out per-project — your call based on phrasing. Don't ask them to specify Stripe; that's the implied source.",
      '- **Visitors / traffic / pageviews** → Google Analytics (`google_analytics`) tracks website pageviews; PostHog tracks app-side events (clicks, signups, custom events). If the user asks about "website visitors" prefer GA; if they say "users in my app" prefer PostHog; if either could apply, query both connections (when present) and clearly label which source each number came from.',
      "- **Meetings / calls** → Calendly.",
      "- **Anything else specifically named** (Beehiiv, Notion, an internal API, etc.) → check the MCP SERVERS list above. If a server with that name exists, use its tools rather than apologising that the platform isn't supported.",
      "- **Open-ended health checks** (\"are we doing good?\", \"how's the business?\") → pull 2-3 anchor metrics from whatever the user has connected: revenue trend (Stripe weekly chart), MRR + active subs (Stripe metric), and recent app activity (PostHog event count if available). Summarise the takeaway in 2-3 sentences. Don't dump every number you can find.",
      "- **Diagnostic 'why' questions** (\"why aren't users subscribing?\", \"why is revenue down?\") → no single tool answers this. Pull two or three relevant signals (e.g. PostHog event counts for the relevant funnel steps + Stripe MRR change) and call out what stands out. Acknowledge that you're inferring from what's measurable, not asserting a cause.",
      '',
      'PostHog event questions:',
      '- The user often describes events by intent ("how many times did a user sign up") rather than the exact event name. PostHog event names are case-sensitive and arbitrary (e.g. `project_submitted`, `user_signup`, `$pageview`).',
      '- Workflow: (1) find the PostHog connection for the relevant project from CONNECTIONS, (2) call `list_posthog_events` to see what event names exist, (3) pick the closest match by name, (4) call `get_posthog_event_count` with the EXACT event name from step 2.',
      "- If multiple events plausibly match (e.g. `signup` and `user_signup` both exist), pick the most specific one and mention which you used so the user can correct you. Don't guess at names that aren't in the list.",
      '- For "recently" / "lately" / vague timeframes, default to **last 7 days** ending today (use the "today" anchor above) and mention the range in your reply.',
      "- If `list_posthog_events` returns 0 events, tell the user the project hasn't recorded any events yet (instead of inventing a name).",
      '',
      'MCP-server tools:',
      '- The MCP tools above are exposed by the user\'s OWN connected servers (think: their personal Beehiiv account, Notion workspace, etc.). You call them like any other tool — the tools[] list has them as `mcp_<idx>__<name>`.',
      '- Read each tool\'s description carefully — MCP servers don\'t share a schema, so input shapes vary wildly.',
      '- If a tool returns a result with `isError: true` or an obvious error message, surface that to the user honestly instead of pretending you got data.',
      '- When citing an MCP-sourced number, name the server (e.g. "12.5% open rate — Beehiiv via Newsletter MCP") so the user can verify.',
    )

    return sections.join('\n')
  }

  // ── MCP tool building ───────────────────────────────────────────────────
  //
  // Fan out to the user's MCP servers, call `tools/list` on each, and
  // build Anthropic-compatible `Tool[]` definitions with namespaced
  // names (so `Beehiiv.list_posts` becomes `mcp_0__list_posts` to
  // Claude). The dispatch map is returned alongside so the agent loop
  // can route a tool_use block back to the right server.
  //
  // Fail-soft: a dead MCP server logs a warning and contributes
  // nothing — the other servers (and the built-in tools) still work.

  private async buildMcpToolsForUser(userId: string): Promise<{
    definitions: Anthropic.Tool[]
    dispatch: Map<string, McpDispatchEntry>
    summaries: McpServerSummary[]
  }> {
    const mcpConns = await this.mcp.listForUser(userId)
    if (mcpConns.length === 0) {
      return { definitions: [], dispatch: new Map(), summaries: [] }
    }

    // Parallel list to keep the latency bound to max(MCP latencies)
    // rather than their sum. `mcpService.listTools` already wraps
    // failures in a returned `[]`, so `Promise.all` here is safe.
    const toolsPerConn = await Promise.all(
      mcpConns.map(c => this.mcp.listTools(c.connectionId, userId)),
    )

    const definitions: Anthropic.Tool[] = []
    const dispatch = new Map<string, McpDispatchEntry>()
    const summaries: McpServerSummary[] = []

    mcpConns.forEach((conn, idx) => {
      const tools = toolsPerConn[idx] ?? []
      summaries.push({
        idx,
        name: conn.name,
        toolNames: tools.map(t => t.name),
      })

      for (const tool of tools) {
        const claudeName = makeMcpToolName(idx, tool.name)
        if (!claudeName) continue // sanitization left nothing usable; skip.
        const description = tool.description
          ? `[${conn.name}] ${tool.description}`
          : `Tool exposed by the user's "${conn.name}" MCP server.`
        // Anthropic requires SOME object schema. MCP servers usually
        // ship one; for the few that don't, default to "no args."
        const schema = (tool.inputSchema as Record<string, unknown> | undefined) ?? {
          type: 'object',
          properties: {},
        }
        definitions.push({
          name: claudeName,
          description,
          input_schema: schema as Anthropic.Tool['input_schema'],
        })
        dispatch.set(claudeName, {
          connectionId: conn.connectionId,
          connectionName: conn.name,
          originalToolName: tool.name,
        })
      }
    })

    return { definitions, dispatch, summaries }
  }

  /**
   * Dispatch an MCP-namespaced tool call. Mirrors the shape of
   * `executeTool` (same `{ result, trace }` envelope) so the agent
   * loop can treat both pathways uniformly.
   */
  private async executeMcpTool(
    claudeName: string,
    entry: McpDispatchEntry,
    input: Record<string, unknown>,
    userId: string,
  ): Promise<{ result: unknown; trace: ToolCallTrace }> {
    try {
      const result = await this.mcp.callTool(
        entry.connectionId,
        userId,
        entry.originalToolName,
        input,
      )
      return {
        result,
        trace: {
          name: claudeName,
          input,
          result,
          mcp: {
            connectionName: entry.connectionName,
            toolName: entry.originalToolName,
          },
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `MCP tool ${claudeName} (${entry.connectionName}.${entry.originalToolName}) failed: ${message}`,
      )
      return {
        result: { error: message },
        trace: {
          name: claudeName,
          input,
          error: message,
          mcp: {
            connectionName: entry.connectionName,
            toolName: entry.originalToolName,
          },
        },
      }
    }
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolCtx,
  ): Promise<{ result: unknown; trace: ToolCallTrace }> {
    const tool = this.tools[toolName]
    if (!tool) {
      const error = `Unknown tool: ${toolName}`
      return {
        result: { error },
        trace: { name: toolName, input, error },
      }
    }
    try {
      const result = await tool.handler(input, ctx)
      return { result, trace: { name: toolName, input, result } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(`tool ${toolName} failed: ${message}`)
      return {
        result: { error: message },
        trace: { name: toolName, input, error: message },
      }
    }
  }

  // ── Agent loop ──────────────────────────────────────────────────────────

  async runAgent(
    messages: Anthropic.MessageParam[],
    userId: string,
    tz: string | null,
  ): Promise<ChatRunResult> {
    if (!this.anthropic) {
      // Should never reach here — controller checks `isConfigured()`
      // before calling — but keep the guard for safety.
      throw new Error('ANTHROPIC_API_KEY is not set')
    }

    // Inventory + MCP discovery run in parallel — both hit external
    // services (Supabase + per-MCP `tools/list` round-trips), no
    // dependency between them. Max(inventory, MCPs) latency rather
    // than sum.
    const [inventoryResult, mcpResult] = await Promise.all([
      this.loadInventory(userId),
      this.buildMcpToolsForUser(userId),
    ])
    const { projects, connections } = inventoryResult
    const { definitions: mcpToolDefinitions, dispatch: mcpDispatch, summaries: mcpSummaries } =
      mcpResult

    const system = this.buildSystemPrompt(projects, connections, tz, mcpSummaries)
    // Built-in tools first, MCP tools after — order doesn't affect
    // the model's choice (it picks by name + description), but keeps
    // the list visually grouped if we ever log it.
    const allTools = [...this.toolDefinitions, ...mcpToolDefinitions]

    // Lookup the renderable builders use to enrich card titles with
    // the source project name — "Gross volume · Databerry" vs the
    // ambiguous "Gross volume" you'd otherwise get when the agent
    // produces multiple parallel cards (one per project) in a single
    // turn. The map is built ONCE per chat turn; builders read it
    // O(1) per tool.
    const projectNamesById = new Map(projects.map(p => [p.id, p.name]))
    const connectionsById = new Map(
      connections.map(c => [
        c.id,
        {
          name: c.name,
          projectName: c.projectId
            ? (projectNamesById.get(c.projectId) ?? null)
            : null,
        },
      ]),
    )
    const renderableCtx: RenderableCtx = { connectionsById }

    let currentMessages: Anthropic.MessageParam[] = messages
    const toolCalls: ToolCallTrace[] = []
    const renderables: Renderable[] = []
    const ctx: ToolCtx = { userId }

    for (let i = 0; i < MAX_AGENT_TURNS; i++) {
      const response = await this.anthropic.messages.create({
        model: MODEL,
        // Caps the assistant's reply length. 1024 tokens ≈ ~750
        // English words — comfortably more than any Q&A response
        // needs, and ½ the previous 2048 cap. Output tokens are the
        // priciest line item, so this directly trims cost on long
        // answers without affecting normal ones.
        max_tokens: 1024,
        // 0.3 = mostly deterministic. The model is doing factual
        // data lookups via tools, not creative writing — we don't
        // want it inventing numbers, and we want repeated questions
        // to give consistent answers.
        temperature: 0.3,
        system,
        tools: allTools,
        messages: currentMessages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === 'text',
        )
        return {
          reply: textBlocks.map(b => b.text).join('\n\n'),
          toolCalls,
          renderables,
        }
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const input = block.input as Record<string, unknown>
            // MCP tools dispatch through a separate code path because
            // they live outside `this.tools` and need credential
            // decryption + remote round-trip per call.
            const mcpEntry = mcpDispatch.get(block.name)
            const { result, trace } = mcpEntry
              ? await this.executeMcpTool(block.name, mcpEntry, input, userId)
              : await this.executeTool(block.name, input, ctx)
            toolCalls.push(trace)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })

            // Derive a visual card from this result (per-tool logic
            // lives in `renderables.ts`). Skip when:
            //   - The cap is hit (avoid 6-card walls of text).
            //   - The tool returned an error (already surfaced in the
            //     trace popover; a card would be redundant + scary).
            //   - The derivation returned `null` (tool doesn't merit
            //     a card — `list_*`, MCP, etc.).
            if (
              renderables.length < MAX_RENDERABLES_PER_TURN &&
              !trace.error
            ) {
              const r = maybeRenderableFor(block.name, input, result, renderableCtx)
              if (r) renderables.push(r)
            }
          }
        }
        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ]
        continue
      }

      // max_tokens / stop_sequence — return whatever text we have.
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      return {
        reply: textBlocks.map(b => b.text).join('\n\n'),
        toolCalls,
        renderables,
      }
    }

    return {
      reply:
        "I wasn't able to finish answering — the conversation hit my tool-call limit. Try a more specific question.",
      toolCalls,
      renderables,
    }
  }
}

// ── MCP helpers ─────────────────────────────────────────────────────────

/** What `buildSystemPrompt` needs to know about each MCP server. */
interface McpServerSummary {
  idx: number
  name: string
  toolNames: string[]
}

/** Per-turn mapping for routing a model tool_use → the right MCP. */
interface McpDispatchEntry {
  connectionId: string
  connectionName: string
  originalToolName: string
}

/**
 * Produce a Claude-safe tool name from `(idx, mcpToolName)`. Anthropic
 * tool names match `^[a-zA-Z0-9_-]{1,64}$`; MCP tool names are
 * basically anything. Sanitize then prefix.
 *
 * Returns null if sanitization leaves nothing (so the caller can
 * skip the tool rather than register an empty-named one).
 */
function makeMcpToolName(idx: number, mcpToolName: string): string | null {
  const cleaned = mcpToolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  if (!cleaned) return null
  return `mcp_${idx}__${cleaned}`
}
