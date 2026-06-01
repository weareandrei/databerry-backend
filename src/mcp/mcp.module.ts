import { Module } from '@nestjs/common'
import { McpService } from './mcp.service'
import { McpToolsCacheService } from './mcp-tools-cache.service'

/**
 * Owns the per-user MCP services used by the Ask-AI chat at call
 * time. Two providers:
 *   - `McpService` — raw per-user MCP client (decrypt credentials,
 *     call `tools/list` and `tools/call`).
 *   - `McpToolsCacheService` — short-TTL cache wrapper around
 *     `mcp.listTools`, used by the lazy-loading chat flow to avoid
 *     hammering MCP servers on every meta-tool call.
 *
 * Both exported so `ChatModule`'s tool layer can inject them. The
 * connection validation helper (`mcp-validate.ts`) is a pure
 * function used directly by `ConnectionsService` — it doesn't need
 * to participate in DI, so it isn't a provider here.
 *
 * `SupabaseService` is globally available (SupabaseModule is
 * `@Global()`), so no explicit imports.
 */
@Module({
  providers: [McpService, McpToolsCacheService],
  exports: [McpService, McpToolsCacheService],
})
export class McpModule {}
