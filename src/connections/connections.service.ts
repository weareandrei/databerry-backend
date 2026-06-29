import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
import { PosthogCredentialsService } from '../posthog/connection/credentials'
import { StripeBackfillService } from '../stripe/sync/backfill.service'
import { encryptForUser } from '../common/crypto/encryption'
import { validateMcpConnection } from '../mcp/mcp-validate'
import { ConnectionsRepository } from './connections.repository'

export interface CreateConnectionDto {
  name: string
  type: string
  // projectId: null / undefined = "Common" (shared across all projects).
  // A non-null UUID scopes the connection to a single project.
  projectId?: string | null
  config?: Record<string, unknown> // type-specific credentials (e.g. apiKey, projectId)
}

export interface UpdateConnectionDto {
  name?: string
}

export interface UpdateConnectionProjectDto {
  projectId: string | null
}

@Injectable()
export class ConnectionsService {
  // Every Supabase failure path used to throw a raw `new Error(error.message)`
  // with no log line, so when a connection-create silently 500'd in
  // production the only artifact was an opaque message in the
  // frontend toast. Adding a `Logger.warn` immediately before each
  // throw gives us a server-side audit trail (operation name + user
  // + raw Supabase error) while still surfacing a sanitized message
  // to the client.
  private readonly logger = new Logger(ConnectionsService.name)

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly posthogCredentialsService: PosthogCredentialsService,
    private readonly stripeBackfillService: StripeBackfillService,
  ) {}

  async getConnections(userId: string) {
    const { data, error } = await this.connectionsRepository.findByUserIdWithJoins(userId)

    if (error) {
      this.logger.warn(`getConnections failed for user ${userId}: ${error.message}`)
      throw new Error(error.message)
    }
    return data.map(this.toCamel)
  }

  async getConnectionById(connectionId: string, userId: string) {
    const { data, error } = await this.connectionsRepository.findByIdWithJoins(
      connectionId,
      userId,
    )

    if (error || !data) throw new NotFoundException('Connection not found')
    return this.toCamel(data)
  }

  async createConnection(dto: CreateConnectionDto, userId: string) {
    // 1. Insert base connection record
    // project_id: null ⇒ "Common" (shared across all projects).
    const { data, error } = await this.connectionsRepository.insert({
      name: dto.name,
      type: dto.type,
      user_id: userId,
      project_id: dto.projectId ?? null,
    })

    if (error) {
      this.logger.warn(
        `createConnection: base insert failed (type=${dto.type}, user=${userId}): ${error.message}`,
      )
      throw new Error(error.message)
    }

    // 2. Insert type-specific config table
    if (dto.config || dto.type === 'webhook') {
      await this.insertTypeConfig(dto.type, data.id as string, dto.config ?? {}, userId)
    }

    // Re-fetch with join so webhookId is included in the response
    return this.getConnectionById(data.id as string, userId)
  }

  async updateConnection(connectionId: string, dto: UpdateConnectionDto, userId: string) {
    const { data, error } = await this.connectionsRepository.updateName(
      connectionId,
      userId,
      dto.name!,
    )

    if (error || !data) throw new NotFoundException('Connection not found')
    return this.toCamel(data)
  }

  async updateConnectionProject(
    connectionId: string,
    dto: UpdateConnectionProjectDto,
    userId: string,
  ) {
    // projectId === null ⇒ move to "Common" (shared across projects).
    const { data, error } = await this.connectionsRepository.updateProjectId(
      connectionId,
      userId,
      dto.projectId,
    )

    if (error || !data) throw new NotFoundException('Connection not found')
    // Re-fetch with joins so the full shape (webhookId, gaPropertyName, …) is
    // returned — same as createConnection.
    return this.getConnectionById(connectionId, userId)
  }

  async deleteConnection(connectionId: string, userId: string) {
    const { error } = await this.connectionsRepository.delete(connectionId, userId)

    if (error) {
      this.logger.warn(
        `deleteConnection failed (id=${connectionId}, user=${userId}): ${error.message}`,
      )
      throw new Error(error.message)
    }
  }

  async getPosthogEventDefinitions(connectionId: string, userId: string) {
    return this.posthogCredentialsService.getEventDefinitions(connectionId, userId)
  }

  async createWebhookKey(connectionId: string, name: string, userId: string) {
    // Verify connection belongs to user
    await this.getConnectionById(connectionId, userId)

    const rawKey = 'kwh_' + randomBytes(16).toString('hex')
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.slice(0, 12)

    const { data, error } = await this.connectionsRepository.insertWebhookKey({
      connection_id: connectionId,
      name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
    })

    if (error) {
      this.logger.warn(
        `createWebhookKey insert failed (connection=${connectionId}): ${error.message}`,
      )
      throw new Error(error.message)
    }

    return {
      id: data.id,
      name: data.name,
      keyPrefix: data.key_prefix,
      createdAt: data.created_at,
      key: rawKey, // returned ONCE only
    }
  }

  async getWebhookKeys(connectionId: string, userId: string) {
    await this.getConnectionById(connectionId, userId)

    const { data, error } =
      await this.connectionsRepository.findWebhookKeysByConnectionId(connectionId)

    if (error) {
      this.logger.warn(
        `getWebhookKeys failed (connection=${connectionId}): ${error.message}`,
      )
      throw new Error(error.message)
    }
    return data.map(row => ({
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }))
  }

  async revokeWebhookKey(connectionId: string, keyId: string, userId: string) {
    await this.getConnectionById(connectionId, userId)

    const { error } = await this.connectionsRepository.revokeWebhookKey(
      connectionId,
      keyId,
      new Date().toISOString(),
    )

    if (error) {
      this.logger.warn(
        `revokeWebhookKey failed (connection=${connectionId}, key=${keyId}): ${error.message}`,
      )
      throw new Error(error.message)
    }
  }

  private async insertTypeConfig(
    type: string,
    connectionId: string,
    config: Record<string, unknown>,
    userId: string,
  ) {
    if (type === 'posthog') {
      // Encrypt the api_key with the per-user envelope before write.
      // See `common/crypto/encryption.ts` for the algorithm rationale.
      const { error } = await this.connectionsRepository.insertPosthog({
        connection_id: connectionId,
        api_key: encryptForUser(config.apiKey as string, userId),
        project_id: config.projectId,
        host: (config.host as string | undefined) ?? 'https://app.posthog.com',
      })
      if (error) {
        this.logger.warn(
          `insertTypeConfig (posthog) failed (connection=${connectionId}): ${error.message}`,
        )
        throw new Error(error.message)
      }
    } else if (type === 'webhook') {
      const { error } = await this.connectionsRepository.insertWebhook(connectionId)
      if (error) {
        this.logger.warn(
          `insertTypeConfig (webhook) failed (connection=${connectionId}): ${error.message}`,
        )
        throw new Error(error.message)
      }
    } else if (type === 'stripe_manual') {
      // Resolve the Stripe account ID first so the row links to stripe_accounts
      // immediately. This also validates the API key (a bad key surfaces here
      // rather than later during backfill, with a cleaner error path).
      const apiKey = config.apiKey as string | undefined
      if (!apiKey) {
        throw new BadRequestException('Stripe API key is required to create this connection.')
      }

      // Pre-flight prefix check — catches the most common copy-paste
      // mistake (publishable key in the secret-key field) BEFORE we
      // hit Stripe. The /v1/account call below would catch it too,
      // but with a less actionable message; this short-circuit names
      // the exact gotcha. Valid prefixes per Stripe docs: `sk_*` for
      // standard secret keys, `rk_*` for restricted keys.
      const trimmed = apiKey.trim()
      if (trimmed.startsWith('pk_')) {
        this.logger.warn(
          `Stripe Manual connection rejected: publishable key prefix (pk_) detected`,
        )
        throw new BadRequestException(
          "That looks like a Publishable key (starts with `pk_`). Stripe needs a Secret key " +
            'for read access — either a Restricted key (`rk_*`, recommended) or a standard ' +
            'Secret key (`sk_*`). Get one from dashboard.stripe.com → Developers → API keys.',
        )
      }
      if (trimmed.startsWith('whsec_')) {
        this.logger.warn(
          `Stripe Manual connection rejected: webhook secret prefix (whsec_) detected`,
        )
        throw new BadRequestException(
          "That looks like a webhook signing secret (starts with `whsec_`). We need a " +
            'Restricted key (`rk_*`) or Secret key (`sk_*`) instead. Create one in ' +
            'dashboard.stripe.com → Developers → API keys.',
        )
      }
      if (!trimmed.startsWith('sk_') && !trimmed.startsWith('rk_')) {
        this.logger.warn(
          `Stripe Manual connection rejected: unrecognised key prefix`,
        )
        throw new BadRequestException(
          "This doesn't look like a Stripe Secret or Restricted key. Valid keys start with " +
            '`sk_` or `rk_`. Create one at dashboard.stripe.com → Developers → API keys.',
        )
      }

      // Now hand off to /v1/account. If the key is structurally
      // valid but rejected (rotated, deleted, scoped wrong), the
      // getter throws `UnauthorizedException` with Stripe's own
      // error message — also user-readable.
      let accountRow
      try {
        accountRow = await this.stripeBackfillService.resolveAccountFromApiKey(apiKey)
      } catch (err) {
        // Surface a tighter framing than Stripe's raw "Invalid API Key
        // provided" — most users hitting this case rotated a key and
        // pasted the old one.
        const message =
          err instanceof Error && err.message
            ? `Stripe didn't accept this key: ${err.message}. Double-check it's the most recent version (rotating a key invalidates the old one).`
            : "Stripe didn't accept this key. Double-check it's correct and try again."
        this.logger.warn(`Stripe Manual /v1/account failed: ${String(err)}`)
        throw new BadRequestException(message)
      }

      // ORDER MATTERS. The credential row FKs into `stripe_accounts.id`,
      // so the parent row must exist first — otherwise the insert below
      // explodes with `connections_stripe_manual_stripe_account_id_fkey`.
      // The upsert is awaited; the backfill itself is kicked AFTER the
      // credential row is in place so `createStripeApiClientForAccount` can
      // find credentials when it runs.
      await this.stripeBackfillService.upsertAccountRow(accountRow)

      // Encrypt the api_key with the per-user envelope. The plaintext
      // `apiKey` was just used above to validate against /v1/account
      // and resolve the account row, so we know it's good before
      // committing the encrypted form.
      const { error } = await this.connectionsRepository.insertStripeManual({
        connection_id: connectionId,
        api_key: encryptForUser(apiKey, userId),
        stripe_account_id: accountRow.id,
      })
      if (error) {
        this.logger.warn(
          `insertTypeConfig (stripe_manual) failed (connection=${connectionId}, stripe_account=${accountRow.id}): ${error.message}`,
        )
        throw new Error(error.message)
      }

      // Fire-and-forget. First-time accounts get a full 90-day backfill;
      // accounts already linked via another connection (same
      // `stripe_account_id`) get a gap-fill from `last_synced_at` to now,
      // so the dashboard reflects anything that's happened since the
      // previous sync. The bare `kickBackfill` short-circuits in the
      // already-complete case and was the source of the "I reconnected
      // but my dashboard is still $0" bug.
      this.stripeBackfillService.kickBackfillOnConnect(accountRow.id)
    } else if (type === 'calendly') {
      // Credentials are inserted directly by CalendlyService.handleOAuthCallback — no-op here
    } else if (type === 'vercel') {
      // Encrypt the api_token with the per-user envelope before write.
      const { error } = await this.connectionsRepository.insertVercel({
        connection_id: connectionId,
        api_token: encryptForUser(config.apiToken as string, userId),
        project_id: config.projectId,
        project_name: config.projectName,
      })
      if (error) {
        this.logger.warn(
          `insertTypeConfig (vercel) failed (connection=${connectionId}): ${error.message}`,
        )
        throw new Error(error.message)
      }
    } else if (type === 'mcp') {
      // MCP connections are generic: name + URL + (none / bearer /
      // custom-header) auth + optional extra headers. We validate
      // against the live server BEFORE persisting so users get an
      // immediate "this works" / "this doesn't work because X" rather
      // than a silent half-broken connection. Validation runs MCP's
      // `initialize` + `tools/list` handshake — see `mcp/mcp-validate.ts`.
      //
      // On validation failure: log the original error for ops + throw
      // a 400 with a user-readable message. On success: encrypt the
      // credential material with the per-user envelope (same as every
      // other credential table here) and insert.
      const serverUrl = (config.serverUrl as string | undefined)?.trim()
      const authType = config.authType as 'none' | 'bearer' | 'custom_header' | undefined
      const authCredential = (config.authCredential as string | undefined) ?? null
      const authHeaderName = (config.authHeaderName as string | undefined)?.trim() || null
      const extraHeaders =
        (config.extraHeaders as Record<string, string> | undefined) ?? null

      if (!serverUrl) {
        throw new BadRequestException('MCP server URL is required.')
      }
      if (!authType || !['none', 'bearer', 'custom_header'].includes(authType)) {
        throw new BadRequestException(
          `Unknown MCP auth type "${String(authType)}". Use 'none', 'bearer', or 'custom_header'.`,
        )
      }
      // Shape checks mirror the SQL CHECK constraint — catch them
      // here so the error is actionable instead of a generic DB
      // constraint violation.
      if (authType === 'bearer' && !authCredential) {
        throw new BadRequestException('MCP bearer auth requires a token.')
      }
      if (authType === 'custom_header' && (!authCredential || !authHeaderName)) {
        throw new BadRequestException(
          'MCP custom-header auth requires both a header name and a value.',
        )
      }

      try {
        await validateMcpConnection({
          serverUrl,
          authType,
          authCredential,
          authHeaderName,
          extraHeaders,
        })
      } catch (err) {
        // Log the raw error for ops (URL is OK to log; secrets are not
        // in the message because `validateMcpConnection` never echoes
        // credentials back into errors). Re-throw as 400 so the user
        // sees the same message the validator produced.
        const message = err instanceof Error ? err.message : String(err)
        this.logger.warn(
          `MCP validate failed (user=${userId}, url=${serverUrl}): ${message}`,
        )
        throw new BadRequestException(message)
      }

      const { error } = await this.connectionsRepository.insertMcp({
        connection_id: connectionId,
        server_url: serverUrl,
        auth_type: authType,
        auth_credential:
          authCredential != null ? encryptForUser(authCredential, userId) : null,
        auth_header_name: authHeaderName,
        extra_headers:
          extraHeaders != null
            ? encryptForUser(JSON.stringify(extraHeaders), userId)
            : null,
      })
      if (error) {
        this.logger.warn(
          `insertTypeConfig (mcp) failed (connection=${connectionId}): ${error.message}`,
        )
        throw new Error(error.message)
      }
    }
  }

  private toCamel(row: Record<string, unknown>) {
    // Supabase may return one-to-one embedded resources as a plain object (not array)
    // when a unique constraint exists on the FK column. Handle both shapes defensively.
    const webhookRaw = row.connections_webhook
    const webhookRow = Array.isArray(webhookRaw)
      ? (webhookRaw as { webhook_id: string }[])[0]
      : (webhookRaw as { webhook_id: string } | null)

    const gaRaw = row.connections_google_analytics
    const gaRow = Array.isArray(gaRaw)
      ? (gaRaw as { property_id: string | null; property_name: string | null }[])[0]
      : (gaRaw as { property_id: string | null; property_name: string | null } | null)

    const vercelRaw = row.connections_vercel
    const vercelRow = Array.isArray(vercelRaw)
      ? (vercelRaw as { project_name: string | null }[])[0]
      : (vercelRaw as { project_name: string | null } | null)

    // MCP-specific surface: only `server_url` + `auth_type` (no
    // credentials) are joined in, so the connection list can render
    // a row per MCP server without ever round-tripping the encrypted
    // token to the client.
    const mcpRaw = row.connections_mcp
    const mcpRow = Array.isArray(mcpRaw)
      ? (mcpRaw as { server_url: string; auth_type: string }[])[0]
      : (mcpRaw as { server_url: string; auth_type: string } | null)

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      userId: row.user_id,
      // project_id is nullable in the DB — null == "Common" (shared across
      // all of this user's projects). Non-null scopes to a single project.
      projectId: (row.project_id as string | null) ?? null,
      createdAt: row.created_at,
      webhookId: webhookRow?.webhook_id ?? null,
      gaPropertyId: gaRow?.property_id ?? null,
      gaPropertyName: gaRow?.property_name ?? null,
      vercelProjectName: vercelRow?.project_name ?? null,
      mcpServerUrl: mcpRow?.server_url ?? null,
      mcpAuthType: mcpRow?.auth_type ?? null,
    }
  }
}
