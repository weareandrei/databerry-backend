import { Injectable, Logger } from '@nestjs/common'
import { McpService } from './mcp.service'
import type { McpToolDefinition } from './mcp-client'

/**
 * Short-TTL cache of `tools/list` results, keyed per
 * (userId, connectionId).
 *
 * Why we need this:
 *   - The chat agent's lazy-loading flow may call `mcp_list_tools`
 *     (and indirectly the system-prompt catalog build) multiple
 *     times in a single user turn, or across rapid consecutive
 *     turns within a chat session.
 *   - Without caching, each call round-trips to the MCP server —
 *     slow (especially for the user's first MCP turn, where the
 *     agent often does `list_tools` → `inspect_tool` → `call_tool`
 *     within ~3 model rounds) and rude to the MCP server (no
 *     per-server rate-limit headroom for free).
 *
 * Why short TTL (60 s by default):
 *   - MCP servers can update their tool catalog at any time
 *     (deployments, feature toggles, per-account exposure).
 *   - 60 s is short enough that "I just deployed a new tool" works
 *     within a fresh chat session.
 *   - Long enough that an active user-turn (which finishes in <
 *     10 s usually) sees consistent results.
 *
 * In-memory only. The pod boundary IS the cache scope. Multi-pod
 * deploys may see brief inconsistency right after an MCP server
 * update — acceptable given the TTL.
 *
 * NOT a security boundary: still uses per-user (userId, connId)
 * keys so a malicious user can't read another's cached results,
 * but the underlying `mcp.listTools` does the ownership check.
 */
@Injectable()
export class McpToolsCacheService {
  private readonly logger = new Logger(McpToolsCacheService.name)
  private readonly cache = new Map<string, CacheEntry>()
  private readonly TTL_MS = 60_000

  constructor(private readonly mcp: McpService) {}

  /**
   * Return the tool list for a connection, hitting the MCP server
   * only when the cache is cold or stale. Fail-soft: `mcp.listTools`
   * already returns `[]` on failure, so a transient MCP outage
   * surfaces as "no tools" rather than throwing into the chat loop.
   */
  async getToolsFor(
    connectionId: string,
    userId: string,
  ): Promise<McpToolDefinition[]> {
    const key = this.cacheKey(connectionId, userId)
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > now) {
      return cached.tools
    }
    const tools = await this.mcp.listTools(connectionId, userId)
    this.cache.set(key, { tools, expiresAt: now + this.TTL_MS })
    return tools
  }

  /**
   * Invalidate the cached tool list for a single connection — call
   * after a user-initiated reload or after we know the MCP server
   * has changed. Not currently wired anywhere (no UI affordance),
   * left here so future code can refresh without restarting the
   * service.
   */
  invalidate(connectionId: string, userId: string): void {
    this.cache.delete(this.cacheKey(connectionId, userId))
  }

  private cacheKey(connectionId: string, userId: string): string {
    return `${userId}:${connectionId}`
  }
}

interface CacheEntry {
  tools: McpToolDefinition[]
  expiresAt: number
}
