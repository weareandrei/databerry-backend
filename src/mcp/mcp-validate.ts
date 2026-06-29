/**
 * One-shot validation for "add MCP connection" — confirms the server
 * is reachable AND the auth credentials work before we persist the
 * connection. Runs the minimal MCP handshake (initialize + tools/list)
 * via the shared `mcp-client` so this code path and the chat-time
 * path can't drift apart.
 *
 * If either step fails, the helper throws and the caller surfaces a
 * 400 to the user.
 */

import { McpClient, type McpAuthType } from './mcp.client'

// Re-export so the existing import sites in `connections.service.ts`
// don't need to change.
export type { McpAuthType }

export interface McpValidateInput {
  serverUrl: string
  authType: McpAuthType
  /** Bearer token OR custom-header value. Required unless `auth='none'`. */
  authCredential?: string | null
  /** Custom header name. Required iff `auth='custom_header'`. */
  authHeaderName?: string | null
  /** Optional extra headers (object). Merged into the request after auth. */
  extraHeaders?: Record<string, string> | null
}

/**
 * Throws an `Error` with a user-readable message on failure. Caller
 * catches and re-throws as a 400 (BadRequestException) while logging
 * the original message for ops.
 */
export async function validateMcpConnection(input: McpValidateInput): Promise<void> {
  // initialize → handshake + auth check. tools/list → confirms tool
  // exposure works for THIS caller (some servers gate tool exposure
  // behind extra scopes that the handshake doesn't surface). We don't
  // store the tool list here; chat-time fetches it fresh.
  const client = new McpClient(input)
  await client.initialize()
  await client.listTools()
}
