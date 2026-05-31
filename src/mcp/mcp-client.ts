/**
 * Minimal JSON-RPC client for remote MCP servers.
 *
 * Shared between:
 *   - `mcp-validate.ts` — one-shot validation on "add MCP connection"
 *     (initialize + tools/list to confirm the server speaks MCP and
 *     accepts our auth).
 *   - `mcp.service.ts` — chat-time tool listing and tool invocation
 *     (initialize + tools/list at chat start, tools/call per
 *     assistant tool_use block).
 *
 * Why hand-rolled rather than `@modelcontextprotocol/sdk`: we only
 * need request-response over HTTP — no session state, no streaming,
 * no resources or prompts. The SDK pays a fair amount of complexity
 * for capabilities we don't yet use. When we add stateful flows
 * (long-running sampling, server-pushed notifications), the SDK will
 * earn its keep; until then a 200-line file is the cheaper bet.
 *
 * Transport notes:
 *   - Most modern remote MCP servers accept JSON-RPC over HTTP POST
 *     with `Content-Type: application/json`. The response may come
 *     back as `application/json` OR `text/event-stream` (Streamable
 *     HTTP). We handle both: JSON is parsed directly; SSE is parsed
 *     by extracting the first `data:` line and JSON-parsing it.
 *   - Local-only stdio MCPs (no remote URL) are out of scope by
 *     design — a hosted backend can't reach them anyway.
 */

const REQUEST_TIMEOUT_MS = 15_000
const PROTOCOL_VERSION = '2024-11-05' // MCP spec version we negotiate with

export type McpAuthType = 'none' | 'bearer' | 'custom_header'

export interface McpConnectionConfig {
  serverUrl: string
  authType: McpAuthType
  /** Bearer token OR custom-header value. Required unless `authType='none'`. */
  authCredential?: string | null
  /** Custom header name. Required iff `authType='custom_header'`. */
  authHeaderName?: string | null
  /** Optional extra headers (object). Merged into the request after auth. */
  extraHeaders?: Record<string, string> | null
}

/** MCP tool definition as returned by `tools/list`. */
export interface McpToolDefinition {
  name: string
  description?: string
  /**
   * JSON-schema for the tool's arguments. Some servers omit this for
   * zero-arg tools, in which case we default to `{ type: 'object' }`
   * before handing it to Claude (Anthropic requires SOME schema).
   */
  inputSchema?: Record<string, unknown>
}

/**
 * Build the headers object common to every JSON-RPC call against the
 * MCP server: content-type + the negotiated auth scheme + any extra
 * pass-throughs. Extracted so `validate` and `service` build them
 * identically — drift between the two would mean an auth that works
 * at validate time but silently fails at chat time.
 */
function buildHeaders(config: McpConnectionConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Tell the server we accept both Streamable-HTTP transports. The
    // server picks; we handle either body shape downstream.
    Accept: 'application/json, text/event-stream',
  }
  if (config.authType === 'bearer' && config.authCredential) {
    headers.Authorization = `Bearer ${config.authCredential}`
  } else if (
    config.authType === 'custom_header' &&
    config.authCredential &&
    config.authHeaderName
  ) {
    headers[config.authHeaderName] = config.authCredential
  }
  if (config.extraHeaders) {
    for (const [k, v] of Object.entries(config.extraHeaders)) headers[k] = v
  }
  return headers
}

/**
 * POST a JSON-RPC envelope to the MCP server and resolve with the
 * envelope's `result`. Throws (with a user-readable message) on
 * transport failure, HTTP error, or a JSON-RPC error envelope.
 */
async function rpc(
  url: string,
  headers: Record<string, string>,
  body: object,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (controller.signal.aborted) {
      throw new Error(
        `MCP server didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s — check the URL and try again.`,
      )
    }
    throw new Error(`Couldn't reach the MCP server: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const bodyText = await safeReadText(res)
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `MCP server rejected the credentials (HTTP ${res.status}). Double-check the token / header value.`,
      )
    }
    throw new Error(
      `MCP server returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`,
    )
  }

  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  let parsed: unknown
  if (ct.includes('text/event-stream')) {
    parsed = parseFirstSseJsonEvent(text)
  } else {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        `MCP server returned a non-JSON response (content-type=${ct || 'unknown'}). ` +
          `First chars: ${text.slice(0, 120)}`,
      )
    }
  }

  // JSON-RPC error envelope — surface the server's own error message.
  if (
    parsed &&
    typeof parsed === 'object' &&
    'error' in parsed &&
    (parsed as { error: unknown }).error != null
  ) {
    const e = (parsed as { error: { message?: string; code?: number } }).error
    throw new Error(
      `MCP server rejected the request${e.code != null ? ` (code ${e.code})` : ''}: ${
        e.message ?? 'no message'
      }`,
    )
  }

  // Unpack the JSON-RPC result envelope — callers want `result`, not
  // the framing.
  if (parsed && typeof parsed === 'object' && 'result' in parsed) {
    return (parsed as { result: unknown }).result
  }
  return parsed
}

function parseFirstSseJsonEvent(text: string): unknown {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim()
      if (payload) return JSON.parse(payload)
    }
  }
  throw new Error('MCP server returned an SSE stream with no `data:` event.')
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// ── Public surface ────────────────────────────────────────────────

/** Negotiate the protocol. Throws on transport/auth failure. */
export async function mcpInitialize(config: McpConnectionConfig): Promise<void> {
  const url = new URL(config.serverUrl).toString() // throws on malformed URL
  await rpc(url, buildHeaders(config), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'databerry', version: '1.0.0' },
    },
  })
}

/**
 * Fetch the server's tool list. Returns the tools as the spec defines
 * them — `name`, optional `description`, optional `inputSchema`. The
 * caller is responsible for namespacing / re-shaping for Anthropic.
 */
export async function mcpListTools(
  config: McpConnectionConfig,
): Promise<McpToolDefinition[]> {
  const url = new URL(config.serverUrl).toString()
  const result = await rpc(url, buildHeaders(config), {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !Array.isArray((result as { tools?: unknown }).tools)
  ) {
    throw new Error(
      'MCP server returned an unexpected `tools/list` shape (no `tools` array).',
    )
  }
  return (result as { tools: McpToolDefinition[] }).tools
}

/**
 * Invoke a tool on the MCP server. Returns the raw result object so
 * the caller can hand it straight to the model — usually `{ content:
 * [{type: 'text', text: '...'}], isError?: boolean }` per the MCP
 * spec, but some servers return arbitrary shapes (e.g. plain objects).
 * The model can interpret JSON either way.
 */
export async function mcpCallTool(
  config: McpConnectionConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(config.serverUrl).toString()
  return rpc(url, buildHeaders(config), {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })
}
