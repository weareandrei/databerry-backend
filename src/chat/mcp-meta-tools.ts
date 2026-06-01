/**
 * Three "meta-tools" that lazy-load MCP server capabilities.
 *
 * The previous design dumped every connected MCP's `tools/list`
 * result into the chat-start prompt — full JSON schemas, every
 * turn. A single PostHog MCP brings ~200k tokens of schema, which
 * (a) blew past Gemini 2.5 Flash's effective input budget for cost,
 * (b) used to blow past Claude Sonnet's hard context limit
 * outright, and (c) wasted that money even on "do you have access
 * to PostHog?" turns that never actually called a tool.
 *
 * Replacement: only three small tool declarations go into the
 * prompt. The system prompt carries a one-line *catalog* per
 * server (name + tool count + tool names) so the model knows what
 * exists, then drills in on demand:
 *
 *    mcp_list_tools(serverIndex)
 *      → names + brief descriptions of all the server's tools.
 *
 *    mcp_inspect_tool(serverIndex, toolName)
 *      → the FULL input schema for a single tool, only when the
 *        model actually wants to call it.
 *
 *    mcp_call_tool(serverIndex, toolName, arguments)
 *      → executes. Same dispatch path as before; per-user
 *        credential decrypt + JSON-RPC `tools/call` over HTTPS.
 *
 * Cost math:
 *    Before: ~200k tokens / turn × every turn.
 *    After:  ~5k tokens fixed (built-ins + 3 meta-tools + catalog
 *            text); the first MCP-touching turn pays ~3-10k extra
 *            for list/inspect; cached for 60 s by
 *            `McpToolsCacheService` so subsequent turns are
 *            nearly free.
 *
 * Trade-off: a turn that touches an MCP now needs 2-3 model
 * round-trips instead of 1 (list → inspect → call). The
 * `McpToolsCacheService` makes each round-trip cheap; the model
 * latency is still real. Worth it given the cost reduction.
 */

import type { ChatTool } from './tool-types'
import type { McpToolsCacheService } from '../mcp/mcp-tools-cache.service'
import type { McpService } from '../mcp/mcp.service'

/** Per-turn data the meta-tools close over. */
export interface McpMetaCtx {
  /** ordered list — `serverIndex` argument refers to this array. */
  servers: { connectionId: string; name: string }[]
  cache: McpToolsCacheService
  mcp: McpService
  userId: string
}

/** Build the three meta-tools with closures over per-turn state. */
export function buildMcpMetaTools(ctx: McpMetaCtx): Record<string, ChatTool> {
  const { servers, cache, mcp, userId } = ctx

  // Helper: resolve a `serverIndex` to its connection details. Lets
  // every meta-tool return a structured error when the model passes
  // an out-of-range index, rather than throwing into the chat loop.
  const resolveServer = (rawIndex: unknown):
    | { ok: true; connectionId: string; name: string }
    | { ok: false; error: string } => {
    const idx = Number(rawIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= servers.length) {
      return {
        ok: false,
        error: `serverIndex ${rawIndex} is out of range. Valid: 0 to ${servers.length - 1}.`,
      }
    }
    const s = servers[idx]!
    return { ok: true, connectionId: s.connectionId, name: s.name }
  }

  const listTools: ChatTool = {
    definition: {
      name: 'mcp_list_tools',
      description:
        "List the tools exposed by one of the user's connected MCP servers. The system prompt already gives you a catalog (server names + tool name lists); call this when you need the brief descriptions of each tool to decide which one to use. Returns: `{ tools: [{ name, description }] }`. Cached for 60 s after the first call.",
      input_schema: {
        type: 'object',
        properties: {
          serverIndex: {
            type: 'integer',
            description:
              'Zero-based index of the MCP server in the SYSTEM PROMPT catalog (`mcp_0`, `mcp_1`, …).',
          },
        },
        required: ['serverIndex'],
      },
    },
    handler: async input => {
      const resolved = resolveServer(input.serverIndex)
      if (!resolved.ok) return { error: resolved.error }
      const tools = await cache.getToolsFor(resolved.connectionId, userId)
      return {
        serverName: resolved.name,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description ?? '',
        })),
      }
    },
  }

  const inspectTool: ChatTool = {
    definition: {
      name: 'mcp_inspect_tool',
      description:
        "Return the FULL input schema for a single MCP tool — needed before you call `mcp_call_tool` so you know what arguments to pass. Returns: `{ name, description, inputSchema }` where `inputSchema` is JSON Schema. Call this ONCE per tool you intend to use; don't re-inspect a tool you already inspected in this turn.",
      input_schema: {
        type: 'object',
        properties: {
          serverIndex: {
            type: 'integer',
            description: 'Zero-based MCP server index.',
          },
          toolName: {
            type: 'string',
            description:
              'Exact tool name from `mcp_list_tools` (or from the system prompt catalog if listed).',
          },
        },
        required: ['serverIndex', 'toolName'],
      },
    },
    handler: async input => {
      const resolved = resolveServer(input.serverIndex)
      if (!resolved.ok) return { error: resolved.error }
      const toolName = String(input.toolName ?? '')
      if (!toolName) return { error: 'toolName is required.' }
      const tools = await cache.getToolsFor(resolved.connectionId, userId)
      const found = tools.find(t => t.name === toolName)
      if (!found) {
        return {
          error: `Tool "${toolName}" not found on server "${resolved.name}". Call mcp_list_tools first.`,
          availableTools: tools.map(t => t.name),
        }
      }
      return {
        name: found.name,
        description: found.description ?? '',
        inputSchema: found.inputSchema ?? { type: 'object', properties: {} },
      }
    },
  }

  const callTool: ChatTool = {
    definition: {
      name: 'mcp_call_tool',
      description:
        "Execute an MCP tool. Always call `mcp_inspect_tool` first to learn the input schema — passing the wrong shape will surface as a server error. Returns the raw tool result (usually `{ content: [...] }` per MCP spec, sometimes other shapes). If the result indicates `isError: true`, tell the user honestly instead of pretending you got data.",
      input_schema: {
        type: 'object',
        properties: {
          serverIndex: {
            type: 'integer',
            description: 'Zero-based MCP server index.',
          },
          toolName: {
            type: 'string',
            description:
              'Exact tool name from `mcp_inspect_tool` (case-sensitive).',
          },
          arguments: {
            type: 'object',
            description:
              "Arguments matching the tool's `inputSchema` from `mcp_inspect_tool`. Pass {} if the tool takes no arguments.",
          },
        },
        required: ['serverIndex', 'toolName', 'arguments'],
      },
    },
    handler: async input => {
      const resolved = resolveServer(input.serverIndex)
      if (!resolved.ok) return { error: resolved.error }
      const toolName = String(input.toolName ?? '')
      if (!toolName) return { error: 'toolName is required.' }
      const args =
        input.arguments && typeof input.arguments === 'object'
          ? (input.arguments as Record<string, unknown>)
          : {}
      try {
        const result = await mcp.callTool(
          resolved.connectionId,
          userId,
          toolName,
          args,
        )
        return { result, serverName: resolved.name, toolName }
      } catch (err) {
        // Surface as a structured tool result instead of throwing,
        // so the model can read the error and self-correct (try a
        // different tool, ask the user, etc.).
        return {
          error: err instanceof Error ? err.message : String(err),
          serverName: resolved.name,
          toolName,
        }
      }
    },
  }

  return {
    mcp_list_tools: listTools,
    mcp_inspect_tool: inspectTool,
    mcp_call_tool: callTool,
  }
}
