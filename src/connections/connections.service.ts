import { Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
import { SupabaseService } from '../supabase/supabase.service'
import { PosthogCredentialsService } from '../posthog/connection/credentials'

export interface CreateConnectionDto {
  name: string
  type: string
  config?: Record<string, unknown> // type-specific credentials (e.g. apiKey, projectId)
}

export interface UpdateConnectionDto {
  name?: string
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly posthogCredentialsService: PosthogCredentialsService,
  ) {}

  async getConnections(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('*, connections_webhook(webhook_id), connections_google_analytics(property_id, property_name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data.map(this.toCamel)
  }

  async getConnectionById(connectionId: string, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('*, connections_webhook(webhook_id), connections_google_analytics(property_id, property_name)')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()

    if (error || !data) throw new NotFoundException('Connection not found')
    return this.toCamel(data)
  }

  async createConnection(dto: CreateConnectionDto, userId: string) {
    const client = this.supabaseService.getClient()

    // 1. Insert base connection record
    const { data, error } = await client
      .from('connections')
      .insert({ name: dto.name, type: dto.type, user_id: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)

    // 2. Insert type-specific config table
    if (dto.config || dto.type === 'webhook') {
      await this.insertTypeConfig(dto.type, data.id, dto.config ?? {}, client)
    }

    // Re-fetch with join so webhookId is included in the response
    return this.getConnectionById(data.id as string, userId)
  }

  async updateConnection(connectionId: string, dto: UpdateConnectionDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .update({ name: dto.name })
      .eq('id', connectionId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw new NotFoundException('Connection not found')
    return this.toCamel(data)
  }

  async deleteConnection(connectionId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('connections')
      .delete()
      .eq('id', connectionId)
      .eq('user_id', userId)

    if (error) throw new Error(error.message)
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

    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .insert({ connection_id: connectionId, name, key_hash: keyHash, key_prefix: keyPrefix })
      .select()
      .single()

    if (error) throw new Error(error.message)

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

    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .select('id, name, key_prefix, revoked_at, created_at')
      .eq('connection_id', connectionId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
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

    const { error } = await this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('connection_id', connectionId)

    if (error) throw new Error(error.message)
  }

  private async insertTypeConfig(
    type: string,
    connectionId: string,
    config: Record<string, unknown>,
    client: ReturnType<SupabaseService['getClient']>,
  ) {
    if (type === 'posthog') {
      const { error } = await client.from('connections_posthog').insert({
        connection_id: connectionId,
        api_key: config.apiKey,
        project_id: config.projectId,
        host: config.host ?? 'https://app.posthog.com',
      })
      if (error) throw new Error(error.message)
    } else if (type === 'webhook') {
      const { error } = await client.from('connections_webhook').insert({
        connection_id: connectionId,
      })
      if (error) throw new Error(error.message)
    } else if (type === 'stripe_manual') {
      const { error } = await client.from('connections_stripe_manual').insert({
        connection_id: connectionId,
        api_key: config.apiKey,
      })
      if (error) throw new Error(error.message)
    } else if (type === 'calendly') {
      // Credentials are inserted directly by CalendlyService.handleOAuthCallback — no-op here
    } else if (type === 'vercel') {
      const { error } = await client.from('connections_vercel').insert({
        connection_id: connectionId,
        api_token: config.apiToken,
        project_id: config.projectId,
        project_name: config.projectName,
      })
      if (error) throw new Error(error.message)
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

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      userId: row.user_id,
      createdAt: row.created_at,
      webhookId: webhookRow?.webhook_id ?? null,
      gaPropertyId: gaRow?.property_id ?? null,
      gaPropertyName: gaRow?.property_name ?? null,
    }
  }
}
