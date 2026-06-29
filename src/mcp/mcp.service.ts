import { Injectable, Logger } from '@nestjs/common'
import { ConnectionsRepository } from '../connections/connections.repository'
import { decryptForUser } from '../common/crypto/encryption'
import {
  McpClient,
  type McpAuthType,
  type McpConnectionConfig,
  type McpToolDefinition,
} from './mcp.client'

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

  constructor(private readonly connectionsRepository: ConnectionsRepository) {}

  async listForUser(userId: string): Promise<Array<{
    connectionId: string
    name: string
    projectId: string | null
  }>> {
    const { data, error } = await this.connectionsRepository.findMcpByUserId(userId)

    if (error) {
      this.logger.warn(
        `McpService.listForUser failed (user=${userId}): ${error.message}`,
      )
      return []
    }
    return (data ?? []).map(row => ({
      connectionId: row.id as string,
      name: row.name as string,
      projectId: (row.project_id as string | null) ?? null,
    }))
  }

  async hydrateConfig(
    connectionId: string,
    userId: string,
  ): Promise<McpConnectionConfig> {
    const { data, error } = await this.connectionsRepository.findMcpConfig(
      connectionId,
      userId,
    )

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

  async listTools(connectionId: string, userId: string): Promise<McpToolDefinition[]> {
    try {
      const config = await this.hydrateConfig(connectionId, userId)
      const client = new McpClient(config)
      await client.initialize()
      return await client.listTools()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `mcpListTools failed (connection=${connectionId}): ${message}`,
      )
      return []
    }
  }

  async callTool(
    connectionId: string,
    userId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const config = await this.hydrateConfig(connectionId, userId)
    const client = new McpClient(config)
    await client.initialize()
    return client.callTool(toolName, args)
  }
}

interface McpRow {
  server_url: string
  auth_type: string
  auth_credential: string | null
  auth_header_name: string | null
  extra_headers: string | null
}
