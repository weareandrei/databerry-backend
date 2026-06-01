/**
 * Ask-AI agentic loop, server-side. Built on Gemini 2.5 Flash via
 * `@google/genai`.
 *
 * Why Gemini Flash (not Claude Sonnet, which we used previously):
 *   - ~5-10× cheaper per token on both sides.
 *   - 1M-token effective context window — even with our new lazy
 *     MCP loading, the larger budget removes the "prompt too long"
 *     class of failures entirely.
 *   - Function-calling quality is comparable for this workload
 *     (multi-tool routing + structured arg generation).
 *
 * Lazy MCP tool loading:
 *   - We DON'T concat every MCP server's `tools/list` schemas into
 *     the request anymore (a single PostHog MCP would push the
 *     request past 200k tokens — see PR notes).
 *   - Instead we ship three "meta-tools" (`mcp_list_tools`,
 *     `mcp_inspect_tool`, `mcp_call_tool`) that fetch what's
 *     needed on demand, plus a catalog summary IN PROSE in the
 *     system prompt so the model knows which servers exist and
 *     what each is for.
 *   - `McpToolsCacheService` keeps tools/list responses fresh for
 *     60 s so the model's discover → inspect → call dance during a
 *     single turn doesn't hit the MCP server three times.
 *
 * No DB persistence. The client owns the message log (in
 * localStorage); the server is stateless per request.
 */

import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type GenerateContentResponse,
  type Part,
} from '@google/genai'
import { Injectable, Logger } from '@nestjs/common'
import { ProjectsService } from '../projects/projects.service'
import { ConnectionsService } from '../connections/connections.service'
import { StripeViewsService } from '../stripe/views/views.service'
import { CalendlyViewsService } from '../calendly/views/views.service'
import { PosthogViewsService } from '../posthog/views/views.service'
import { GoogleAnalyticsViewsService } from '../google-analytics/views/views.service'
import { McpService } from '../mcp/mcp.service'
import { McpToolsCacheService } from '../mcp/mcp-tools-cache.service'
import { buildBuiltinTools, type ToolDeps } from './tools'
import { buildMcpMetaTools } from './mcp-meta-tools'
import {
  toGeminiFunctionDeclaration,
  type ChatTool,
  type ToolCtx,
} from './tool-types'
import {
  maybeRenderableFor,
  type Renderable,
  type RenderableCtx,
} from './renderables'

// Gemini 2.5 Flash — the workhorse. `gemini-2.5-flash-lite` would
// be even cheaper but materially weaker at multi-step tool
// reasoning; the savings aren't worth degrading "are we doing
// good?" answers.
const MODEL = 'gemini-2.5-flash'

// Cap on agent iterations within a single user turn. Each
// iteration is one Gemini round-trip. With lazy MCP loading a
// turn can plausibly take more iterations than before (the
// list → inspect → call dance for MCP work), so I bumped this
// from 5 → 8. Still bounded.
const MAX_AGENT_TURNS = 8

// Cap on visual cards per turn — see frontend `Renderables.tsx`.
const MAX_RENDERABLES_PER_TURN = 4

// Neutral conversation message — the controller accepts these
// from the frontend. Conversion to Gemini's `Content[]` happens
// inside `runAgent`.
export interface ChatMessageParam {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCallTrace {
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
  /**
   * Set when the call routed through `mcp_call_tool`. Carries the
   * MCP connection's display name + the original (server-side)
   * tool name so the frontend can render a chip labelled with the
   * MCP name rather than the meta-tool name.
   */
  mcp?: { connectionName: string; toolName: string }
}

export interface ChatRunResult {
  reply: string
  toolCalls: ToolCallTrace[]
  renderables: Renderable[]
}

// ── Date context for the system prompt ─────────────────────────────
//
// Same logic + same rationale as the Claude version: anchor "today",
// "this week", etc. to wall-clock now-in-user-tz so the model doesn't
// invent dates from its training prior.

interface YmdParts {
  year: number
  month: number // 1-12
  day: number
  weekday: string
}

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
  const effectiveTz = tz ?? 'UTC'
  const today = getWallClock(new Date(), effectiveTz)
  const todayStr = fmt(today.year, today.month, today.day)
  const dowIdx = ISO_WEEKDAY_INDEX[today.weekday] ?? 0
  const mondayThisWeek = addDays(today, -dowIdx)
  const sundayThisWeek = addDays(mondayThisWeek, 6)
  const mondayLastWeek = addDays(mondayThisWeek, -7)
  const sundayLastWeek = addDays(mondayThisWeek, -1)
  const monthEnd = new Date(Date.UTC(today.year, today.month, 0))
  const thisMonthStart = fmt(today.year, today.month, 1)
  const thisMonthEnd = fmt(today.year, today.month, monthEnd.getUTCDate())
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

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)
  private readonly genai: GoogleGenAI | null
  private readonly builtinTools: Record<string, ChatTool>

  constructor(
    private readonly projects: ProjectsService,
    private readonly connections: ConnectionsService,
    private readonly stripeViews: StripeViewsService,
    private readonly calendlyViews: CalendlyViewsService,
    private readonly posthogViews: PosthogViewsService,
    private readonly gaViews: GoogleAnalyticsViewsService,
    private readonly mcp: McpService,
    private readonly mcpCache: McpToolsCacheService,
  ) {
    const apiKey = process.env.GEMINI_API_KEY
    this.genai = apiKey ? new GoogleGenAI({ apiKey }) : null

    const deps: ToolDeps = {
      projects,
      connections,
      stripeViews,
      calendlyViews,
      posthogViews,
      gaViews,
      mcp,
    }
    this.builtinTools = buildBuiltinTools(deps)
  }

  isConfigured(): boolean {
    return this.genai !== null
  }

  // ── Inventory ──────────────────────────────────────────────────

  private async loadInventory(userId: string): Promise<{
    projects: { id: string; name: string }[]
    connections: { id: string; name: string; type: string; projectId: string | null }[]
  }> {
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
    const projects = (projectsRaw as Array<{ id: unknown; name: unknown }>).map(
      p => ({ id: String(p.id), name: String(p.name) }),
    )
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

  // ── System prompt ──────────────────────────────────────────────

  private buildSystemPrompt(
    projects: { id: string; name: string }[],
    connections: { id: string; name: string; type: string; projectId: string | null }[],
    tz: string | null,
    mcpCatalog: McpCatalogEntry[],
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

    // MCP CATALOG — names + tool counts + brief tool listings.
    // This replaces the "dump every full schema into tools[]"
    // approach. The model sees what exists and can drill in via
    // `mcp_list_tools` / `mcp_inspect_tool` / `mcp_call_tool`
    // when needed.
    const mcpLines = mcpCatalog.length
      ? mcpCatalog
          .map(e => {
            const previewNames = e.toolNames.slice(0, 12)
            const more =
              e.toolNames.length > previewNames.length
                ? ` + ${e.toolNames.length - previewNames.length} more`
                : ''
            const previewList = previewNames.length
              ? previewNames.join(', ') + more
              : '(no tools exposed)'
            return `- mcp_${e.idx} "${e.name}" — ${e.toolNames.length} tools (${previewList})`
          })
          .join('\n')
      : null

    const sections: string[] = [
      "You are Databerry's data assistant. You help solo founders understand their business by answering questions about the data they've connected.",
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
        'MCP SERVERS (third-party tools the user wired up via MCP — call them via the `mcp_list_tools` / `mcp_inspect_tool` / `mcp_call_tool` meta-tools; full schemas are NOT in the tools list to save tokens):',
        mcpLines,
        '',
        'MCP workflow:',
        "  1. If a server's tool list above already tells you which tool to call, skip to step 2. Otherwise call `mcp_list_tools(serverIndex)` to see brief descriptions.",
        "  2. Call `mcp_inspect_tool(serverIndex, toolName)` to get the EXACT input schema for the tool you want to call.",
        "  3. Call `mcp_call_tool(serverIndex, toolName, arguments)` with arguments shaped per the schema you just inspected.",
        "  If `mcp_call_tool` returns `error` or a result with `isError: true`, surface that honestly — don't fabricate data.",
      )
    }

    sections.push(
      '',
      buildDateContext(tz),
      '',
      'Guidelines:',
      "- When the user names a project, look it up in the PROJECTS list above. You don't need to call list_projects unless the inventory above is empty.",
      '- For metric tools (`get_stripe_metric`, `get_stripe_chart`, `get_posthog_event_count`), pass `tz` from the date context AND derive `dateFrom` / `dateTo` from the anchors for relative queries. NEVER guess dates from your own training data.',
      '- Currency values from Stripe tools are in **cents**. Divide by 100 and format as USD when reporting.',
      '- Cite which connection / project a number came from (e.g. "$1,234 — Stripe on Taplaunch").',
      '- When you mention a date range in your reply, use the SAME range you actually passed to the tool — never paraphrase it.',
      '- Be concise. Markdown is supported.',
      "- If a tool returns `unavailable: true` or an error, tell the user the data isn't available rather than fabricating numbers.",
      '',
      'Routing — picking the right source:',
      '- **Revenue / money / sales** → Stripe. If user names a project, use only that project\'s Stripe connection. If they don\'t and the user has multiple, query each and either sum or break out per-project.',
      '- **Visitors / traffic / pageviews** → Google Analytics (`google_analytics`) for website pageviews; PostHog for app-side events. Query both when ambiguous and label which source each number came from.',
      "- **Meetings / calls** → Calendly.",
      "- **Anything else specifically named** (Beehiiv, Notion, an internal API, etc.) → check the MCP SERVERS list above. If a server with that name exists, use the MCP meta-tools rather than apologising.",
      "- **Open-ended health checks** (\"are we doing good?\") → pull 2-3 anchor metrics from connected sources: revenue trend, MRR + active subs, recent app activity. Summarise in 2-3 sentences. Don't dump every number.",
      "- **Diagnostic 'why' questions** → pull two or three relevant signals and call out what stands out. Acknowledge you're inferring, not asserting cause.",
      '',
      'PostHog event questions:',
      '- PostHog event names are case-sensitive and arbitrary. Workflow: find the PostHog connection for the project from CONNECTIONS → call `list_posthog_events` → pick the closest match by name → call `get_posthog_event_count` with the EXACT name.',
      "- For \"recently\" / vague timeframes, default to **last 7 days** ending today and mention the range in your reply.",
    )

    return sections.join('\n')
  }

  // ── MCP catalog ────────────────────────────────────────────────

  /**
   * Prefetch tools/list for each MCP and produce a small catalog
   * the system prompt can list. NOT the full schemas — just names
   * and brief descriptions, which is what the model needs to know
   * WHICH server to drill into.
   *
   * Fail-soft: a dead MCP server contributes an empty `toolNames`
   * array. The catalog entry still appears so the model knows the
   * server exists; calls to it will then surface the real error
   * via the meta-tools.
   */
  private async buildMcpCatalog(userId: string): Promise<McpCatalogEntry[]> {
    const servers = await this.mcp.listForUser(userId)
    if (servers.length === 0) return []
    const toolsPerServer = await Promise.all(
      servers.map(s => this.mcpCache.getToolsFor(s.connectionId, userId)),
    )
    return servers.map((s, idx) => ({
      idx,
      connectionId: s.connectionId,
      name: s.name,
      toolNames: (toolsPerServer[idx] ?? []).map(t => t.name),
    }))
  }

  // ── Tool dispatch ──────────────────────────────────────────────

  private async executeTool(
    tools: Record<string, ChatTool>,
    name: string,
    input: Record<string, unknown>,
    ctx: ToolCtx,
    catalog: McpCatalogEntry[],
  ): Promise<{ result: unknown; trace: ToolCallTrace }> {
    const tool = tools[name]
    if (!tool) {
      const error = `Unknown tool: ${name}`
      return {
        result: { error },
        trace: { name, input, error },
      }
    }
    try {
      const result = await tool.handler(input, ctx)
      const trace: ToolCallTrace = { name, input, result }
      // Tag `mcp_call_tool` traces with the MCP server name + original
      // tool name so the frontend's chip row labels them "PostHog"
      // (or whatever the connection is called) instead of the generic
      // `mcp_call_tool`. Resolves from the catalog by serverIndex.
      if (name === 'mcp_call_tool') {
        const idx = Number(input.serverIndex)
        const entry = Number.isInteger(idx) ? catalog[idx] : undefined
        if (entry) {
          trace.mcp = {
            connectionName: entry.name,
            toolName: String(input.toolName ?? ''),
          }
        }
      }
      return { result, trace }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(`tool ${name} failed: ${message}`)
      return {
        result: { error: message },
        trace: { name, input, error: message },
      }
    }
  }

  // ── Agent loop ─────────────────────────────────────────────────

  async runAgent(
    messages: ChatMessageParam[],
    userId: string,
    tz: string | null,
  ): Promise<ChatRunResult> {
    if (!this.genai) {
      throw new Error('GEMINI_API_KEY is not set')
    }

    // Build inventory + MCP catalog in parallel — both hit external
    // services, no dependency between them.
    const [inventory, mcpCatalog] = await Promise.all([
      this.loadInventory(userId),
      this.buildMcpCatalog(userId),
    ])
    const { projects, connections } = inventory

    // Meta-tools are built per-turn so they can close over the
    // catalog (the `serverIndex` argument the model sends is
    // resolved against this array).
    const metaTools = buildMcpMetaTools({
      servers: mcpCatalog.map(e => ({
        connectionId: e.connectionId,
        name: e.name,
      })),
      cache: this.mcpCache,
      mcp: this.mcp,
      userId,
    })
    const allTools = { ...this.builtinTools, ...metaTools }
    const geminiTools = Object.values(allTools).map(t =>
      toGeminiFunctionDeclaration(t.definition),
    )

    const system = this.buildSystemPrompt(projects, connections, tz, mcpCatalog)

    // Renderable enrichment context — map connectionId →
    // {name, projectName} so multi-project responses get unique
    // titles ("Gross volume · Databerry" vs. just "Gross volume").
    const projectNamesById = new Map(projects.map(p => [p.id, p.name]))
    const connectionsById = new Map(
      connections.map(c => [
        c.id,
        {
          name: c.name,
          projectName: c.projectId
            ? projectNamesById.get(c.projectId) ?? null
            : null,
        },
      ]),
    )
    const renderableCtx: RenderableCtx = { connectionsById }

    let contents: Content[] = toGeminiContents(messages)
    const toolCalls: ToolCallTrace[] = []
    const renderables: Renderable[] = []
    const ctx: ToolCtx = { userId }

    // Pre-flight log — see how much cheaper this turn is than the
    // old Claude path. Includes the meta-tools + the catalog text;
    // does NOT include the per-MCP full schemas (which we no
    // longer send).
    const systemChars = system.length
    const toolsChars = JSON.stringify(geminiTools).length
    const messagesChars = JSON.stringify(contents).length
    this.logger.log(
      `runAgent prep: user=${userId} model=${MODEL} ` +
        `tools=${geminiTools.length} (builtin=${Object.keys(this.builtinTools).length}, mcp-meta=${Object.keys(metaTools).length}) ` +
        `mcpServers=${mcpCatalog.length} ` +
        `system=${systemChars} chars (~${Math.round(systemChars / 4)} tok) ` +
        `tools=${toolsChars} chars (~${Math.round(toolsChars / 4)} tok) ` +
        `messages=${messagesChars} chars (~${Math.round(messagesChars / 4)} tok) ` +
        `total≈${Math.round((systemChars + toolsChars + messagesChars) / 4)} tok`,
    )

    for (let iter = 0; iter < MAX_AGENT_TURNS; iter++) {
      let response: GenerateContentResponse
      try {
        response = await this.genai.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations: geminiTools }],
            // Mostly deterministic — same rationale as the Claude
            // path. Tool routing is factual lookup, not creative
            // writing.
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
        })
      } catch (err) {
        // Re-throw with a human-readable message extracted from
        // Gemini's JSON error envelope (the SDK's `ApiError`
        // serialises its `.message` as a JSON blob — useless to
        // the user). The controller catches this and surfaces the
        // clean message to the frontend, which renders it as a
        // red error bubble.
        throw new Error(extractGeminiErrorMessage(err))
      }

      // Pull the model's first candidate Content (the next message
      // it wants to send). Gemini structures this as one Content
      // with multiple Parts; the parts may mix text and
      // functionCall blocks within a single response.
      const candidate = response.candidates?.[0]
      const modelContent: Content | undefined = candidate?.content
      const parts: Part[] = modelContent?.parts ?? []

      const functionCalls = parts
        .map(p => p.functionCall)
        .filter((fc): fc is FunctionCall => !!fc)

      if (functionCalls.length === 0) {
        // No tool calls — the model is replying with text. Pull
        // text parts and we're done.
        const reply = parts
          .map(p => (typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('\n\n')
        return { reply, toolCalls, renderables }
      }

      // Tool call(s) — execute each, append both the model's call
      // and our function responses to `contents`, loop.
      const responseParts: Part[] = []
      for (const fc of functionCalls) {
        const name = fc.name ?? ''
        const input = (fc.args as Record<string, unknown>) ?? {}
        const { result, trace } = await this.executeTool(
          allTools,
          name,
          input,
          ctx,
          mcpCatalog,
        )
        toolCalls.push(trace)
        responseParts.push({
          functionResponse: {
            name,
            response: { result },
          },
        })

        // Derive a Renderable if applicable. For `mcp_call_tool`
        // the underlying tool isn't one of the built-in renderable
        // tools, so this is a no-op for MCP calls (matches V1).
        if (renderables.length < MAX_RENDERABLES_PER_TURN && !trace.error) {
          const r = maybeRenderableFor(name, input, result, renderableCtx)
          if (r) renderables.push(r)
        }
      }

      // Append the assistant's tool-calling Content + our user-
      // role functionResponse Content. The next iteration sees
      // the new state and either calls more tools or replies.
      contents = [
        ...contents,
        modelContent ?? { role: 'model', parts },
        { role: 'user', parts: responseParts },
      ]
    }

    return {
      reply:
        "I wasn't able to finish answering — the conversation hit my tool-call limit. Try a more specific question.",
      toolCalls,
      renderables,
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

interface McpCatalogEntry {
  idx: number
  connectionId: string
  name: string
  toolNames: string[]
}

/**
 * Translate the frontend's `{role, content}` shape into Gemini's
 * `Content[]`. Past assistant messages become `role: 'model'`;
 * everything else stays `role: 'user'`. Empty messages are dropped
 * — Gemini rejects zero-length Content items.
 */
function toGeminiContents(messages: ChatMessageParam[]): Content[] {
  return messages
    .filter(m => m.content && m.content.length > 0)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
}

/**
 * Pull a clean, user-readable message out of whatever Gemini SDK
 * error we got. The SDK's `ApiError` exposes the upstream JSON
 * envelope as `err.message` — e.g.:
 *   `{"error":{"code":503,"message":"This model is currently
 *     experiencing high demand…","status":"UNAVAILABLE"}}`
 *
 * Without this, the controller's outer catch would re-throw the
 * whole JSON blob, and users see the literal payload in their chat
 * surface. Parse it instead and return just `error.message`.
 *
 * Fallback chain:
 *   1. JSON-parse `err.message`, return `parsed.error.message`.
 *   2. JSON-parse, return `parsed.message` (some SDK error shapes).
 *   3. The raw error message (already a string from Node `Error`).
 *   4. Hardcoded fallback if nothing's available.
 */
function extractGeminiErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''
  if (!raw) return 'The AI service returned an unknown error.'
  // The SDK sometimes prefixes the JSON with `got status: X. ` — try
  // to scrub that before parsing.
  const cleaned = raw.replace(/^got status:\s*\d+\.\s*/i, '').trim()
  // Many errors are pure JSON; some are JSON with leading prose.
  // Try to find the first `{` and parse from there.
  const firstBrace = cleaned.indexOf('{')
  if (firstBrace >= 0) {
    const candidate = cleaned.slice(firstBrace)
    try {
      const parsed = JSON.parse(candidate) as {
        error?: { message?: string; status?: string; code?: number }
        message?: string
      }
      if (parsed.error?.message) return parsed.error.message
      if (parsed.message) return parsed.message
    } catch {
      // Not parseable JSON — fall through to the raw message.
    }
  }
  return cleaned || raw
}
