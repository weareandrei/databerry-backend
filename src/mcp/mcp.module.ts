import { Module } from '@nestjs/common'
import { McpService } from './mcp.service'

/**
 * Owns the per-user MCP service used by the Ask-AI chat at call
 * time. Exported so `ChatModule` can inject it into the tool layer.
 *
 * The connection validation helper (`mcp-validate.ts`) is a pure
 * function used directly by `ConnectionsService` — it doesn't need
 * to participate in DI, so it isn't a provider here.
 *
 * `SupabaseService` is globally available (SupabaseModule is
 * `@Global()`), so no explicit imports.
 */
@Module({
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
