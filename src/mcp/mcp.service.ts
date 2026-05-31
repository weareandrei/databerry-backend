import { Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { decryptForUser } from '../common/crypto/encryption'
import {
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  type McpAuthType,
  type McpConnectionConfig,
  type McpToolDefinition,
} from './mcp-client'

/**
 * Per-user MCP service used by the Ask-AI chat at call time.
 *
 * Responsibilities:
 *   1. Hydrate an MCP connection's full credential set (decrypted)
 *      from `connections_mcp` — `ConnectionsService.getConnections`
 *      deliberately joins only the non-secret fields, so we can't
 *      reuse it.
 *   2. Hand the credentials to the shared `mcp-client` helpers
 *      (`mcpListTools`, `mcpCallTool`) and surface the result.
 *
 * Per-user scoping: every public method requires `userId` AND looks
 * up the row by `connection_id + user_id`. A bug that swaps user
 * IDs results in a NotFound, not a cross-user leak.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name)

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * List the user's MCP connections WITH the metadata needed to
   * dispatch (id + display name + project assignment). Credentials
   * are NOT returned here — `hydrateConfig` does that lazily, once
   * per actual MCP call.
   */
  async listForUser(userId: string): Promise<Array<{
    connectionId: string
    name: string
    projectId: string | null
  }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('connections')
      .select('id, name, project_id, type')
      .eq('user_id', userId)
      .eq('type', 'mcp')

    if (error) {
      this.logger.warn(
        `McpService.listForUser failed (user=${userId}): ${error.message}`,
      )
      // Treat as "no MCPs available" rather than blowing up the whole
      // chat turn. The agent gracefully falls back to built-in tools.
      return []
    }
    return (data ?? []).map(row => ({
      connectionId: row.id as string,
      name: row.name as string,
      projectId: (row.project_id as string | null) ?? null,
    }))
  }

  /**
   * Hydrate the full MCP config for a single connection — decrypts
   * the credential and any extra headers. Throws a user-readable
   * Error on missing config or decryption failure so the chat tool
   * dispatch can surface it as the tool's error result.
   */
  async hydrateConfig(
    connectionId: string,
    userId: string,
  ): Promise<McpConnectionConfig> {
    // Join connections + connections_mcp + filter by user. One round
    // trip. We need the `user_id` on `connections` to ensure the row
    // belongs to the caller before we decrypt (decryption with the
    // wrong userId would fail auth-tag check, but failing earlier is
    // cleaner).
    const { data, error } = await this.supabase
      .getClient()
      .from('connections')
      .select(
        'id, user_id, connections_mcp(server_url, auth_type, auth_credential, auth_header_name, extra_headers)',
      )
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()

    if (error || !data) {
      throw new Error(`MCP connection ${connectionId} not found for this user.`)
    }
    const mcpRaw = (data as { connections_mcp: unknown }).connections_mcp
    const mcpRow = Array.isArray(mcpRaw)
      ? (mcpRaw[0] as McpRow | undefined)
      : (mcpRaw as McpRow | null)
    if (!mcpRow) {
      throw new Error(`MCP row missing for connection ${connectionId}.`)
    }

    const authType = mcpRow.auth_type as McpAuthType
    const authCredential =
      mcpRow.auth_credential != null
        ? decryptForUser(mcpRow.auth_credential, userId)
        : null
    const extraHeaders =
      mcpRow.extra_headers != null
        ? (JSON.parse(decryptForUser(mcpRow.extra_headers, userId)) as Record<
            string,
            string
          >)
        : null

    return {
      serverUrl: mcpRow.server_url,
      authType,
      authCredential,
      authHeaderName: mcpRow.auth_header_name,
      extraHeaders,
    }
  }

  /**
   * Call `tools/list` on the connection. Fail-soft: returns `[]` on
   * any error so a single dead MCP server doesn't block the rest of
   * the user's MCPs (or built-in tools) from being available.
   */
  async listTools(connectionId: string, userId: string): Promise<McpToolDefinition[]> {
    try {
      const config = await this.hydrateConfig(connectionId, userId)
      // Some servers require initialize first, some don't. Doing it
      // is cheap and matches the spec.
      await mcpInitialize(config)
      return await mcpListTools(config)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `mcpListTools failed (connection=${connectionId}): ${message}`,
      )
      return []
    }
  }

  /**
   * Call `tools/call` on the connection. Throws on failure — the
   * chat dispatcher catches and renders the error as the tool's
   * error result, so the model can react ("the MCP server said X,
   * try a different approach") instead of the whole turn dying.
   */
  async callTool(
    connectionId: string,
    userId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const config = await this.hydrateConfig(connectionId, userId)
    await mcpInitialize(config)
    return mcpCallTool(config, toolName, args)
  }
}

interface McpRow {
  server_url: string
  auth_type: string
  auth_credential: string | null
  auth_header_name: string | null
  extra_headers: string | null
}
