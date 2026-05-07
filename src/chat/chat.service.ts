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
import { buildTools, type ChatTool, type ToolCtx, type ToolDeps } from './tools'

// Sonnet 4.5 instead of Opus 4.5: ~5× cheaper across input + output
// tokens, still extremely capable at tool-using chat. Opus is overkill
// for "answer a question about your Stripe MRR" — Sonnet handles
// multi-tool reasoning fine. Bump to Opus only if we see Sonnet
// missing tool calls or producing worse summaries.
const MODEL = 'claude-sonnet-4-5'
const MAX_AGENT_TURNS = 5

export interface ToolCallTrace {
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface ChatRunResult {
  reply: string
  toolCalls: ToolCallTrace[]
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
    connections: { id: string; type: string; projectId: string | null }[]
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
      connectionsRaw as Array<{ id: unknown; type: unknown; projectId: unknown }>
    ).map(c => ({
      id: String(c.id),
      type: String(c.type),
      projectId: (c.projectId as string | null | undefined) ?? null,
    }))
    return { projects, connections }
  }

  private buildSystemPrompt(
    projects: { id: string; name: string }[],
    connections: { id: string; type: string; projectId: string | null }[],
    tz: string | null,
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

    return [
      "You are Databerry's data assistant. You help solo founders understand their business by answering questions about the data they've connected (Stripe, Calendly, etc.).",
      '',
      'The current user has the following projects and connections:',
      '',
      'PROJECTS:',
      projectLines,
      '',
      'CONNECTIONS:',
      connLines,
      '',
      `User timezone: ${tz ?? 'UTC (unknown)'}`,
      '',
      'Guidelines:',
      "- When the user names a project, look it up in the PROJECTS list above. You don't need to call list_projects unless the inventory above is empty.",
      "- For metric tools (`get_stripe_metric`, `get_stripe_chart`), pass `tz` from the system prompt above when the user asks about \"today\", \"this week\", etc.",
      '- Currency values from Stripe tools are in **cents**. Divide by 100 and format as USD when reporting (e.g. `$1,234.56`).',
      '- Cite which connection / project a number came from (e.g. "$1,234 — Stripe on Taplaunch").',
      '- Be concise. Markdown is supported (bold, lists, inline code).',
      "- If a tool returns `unavailable: true` or an error, tell the user the data isn't available rather than fabricating numbers.",
    ].join('\n')
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

    const { projects, connections } = await this.loadInventory(userId)
    const system = this.buildSystemPrompt(projects, connections, tz)

    let currentMessages: Anthropic.MessageParam[] = messages
    const toolCalls: ToolCallTrace[] = []
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
        tools: this.toolDefinitions,
        messages: currentMessages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === 'text',
        )
        return { reply: textBlocks.map(b => b.text).join('\n\n'), toolCalls }
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const { result, trace } = await this.executeTool(
              block.name,
              block.input as Record<string, unknown>,
              ctx,
            )
            toolCalls.push(trace)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })
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
      return { reply: textBlocks.map(b => b.text).join('\n\n'), toolCalls }
    }

    return {
      reply:
        "I wasn't able to finish answering — the conversation hit my tool-call limit. Try a more specific question.",
      toolCalls,
    }
  }
}
