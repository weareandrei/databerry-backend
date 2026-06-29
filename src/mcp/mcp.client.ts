import {
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  type McpConnectionConfig,
  type McpToolDefinition,
} from './mcp-client'

export type { McpAuthType, McpConnectionConfig, McpToolDefinition } from './mcp-client'

/**
 * JSON-RPC client for one remote MCP server. One instance per connection
 * config — never a singleton.
 */
export class McpClient {
  constructor(private readonly config: McpConnectionConfig) {}

  /** Negotiate the protocol. Throws on transport/auth failure. */
  async initialize(): Promise<void> {
    return mcpInitialize(this.config)
  }

  /** Fetch the server's tool list. */
  async listTools(): Promise<McpToolDefinition[]> {
    return mcpListTools(this.config)
  }

  /** Invoke a tool on the MCP server. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return mcpCallTool(this.config, toolName, args)
  }
}
