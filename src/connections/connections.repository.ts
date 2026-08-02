import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export type StripeCredentialTable = 'connections_stripe' | 'connections_stripe_manual'

const CONNECTION_SELECT_WITH_JOINS =
  '*, connections_webhook(webhook_id), connections_google_analytics(property_id, property_name), connections_vercel(project_name), connections_mcp(server_url, auth_type)'

@Injectable()
export class ConnectionsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  findByUserIdWithJoins(userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select(CONNECTION_SELECT_WITH_JOINS)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
  }

  findByIdWithJoins(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select(CONNECTION_SELECT_WITH_JOINS)
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()
  }

  insert(row: {
    name: string
    type: string
    user_id: string
    project_id?: string | null
  }) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .insert({
        name: row.name,
        type: row.type,
        user_id: row.user_id,
        project_id: row.project_id ?? null,
      })
      .select()
      .single()
  }

  updateName(connectionId: string, userId: string, name: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .update({ name })
      .eq('id', connectionId)
      .eq('user_id', userId)
      .select()
      .single()
  }

  updateProjectId(connectionId: string, userId: string, projectId: string | null) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .update({ project_id: projectId })
      .eq('id', connectionId)
      .eq('user_id', userId)
      .select()
      .single()
  }

  delete(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .delete()
      .eq('id', connectionId)
      .eq('user_id', userId)
  }

  deleteById(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .delete()
      .eq('id', connectionId)
  }

  findIdByConnectionAndUser(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findTypesByUserId(userId: string, types: string[]) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('type')
      .eq('user_id', userId)
      .in('type', types)
  }

  /**
   * List connections for a user, optionally filtered by type and/or
   * project. When `projectId` is set the match is STRICT — only
   * connections scoped to that project. Common (`project_id IS NULL`)
   * is intentionally excluded: auto-including it silently leaked the
   * same PostHog/Stripe people into every new project (mirrors the
   * overview traffic fix in `pickTrafficProvider`). Assign a
   * connection to the project explicitly if it should sync there.
   */
  findConnections(
    opts: { userId?: string; types?: string[]; projectId?: string; select?: string } = {},
  ) {
    let query = this.supabaseService
      .getClient()
      .from('connections')
      .select(opts.select ?? 'id, type')

    if (opts.userId) {
      query = query.eq('user_id', opts.userId)
    }

    if (opts.types?.length) {
      query = query.in('type', opts.types)
    }

    if (opts.projectId) {
      query = query.eq('project_id', opts.projectId)
    }

    return query
  }

  findTypeById(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findTypeAndProjectId(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('type, project_id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findIdAndTypeByIdAndUserId(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findTypeByConnectionId(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('type')
      .eq('id', connectionId)
      .maybeSingle()
  }

  findAnyOwnedId(userId: string, connectionIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('user_id', userId)
      .in('id', connectionIds)
      .limit(1)
  }

  findAllByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type, project_id')
      .eq('user_id', userId)
  }

  findMcpByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, name, project_id, type')
      .eq('user_id', userId)
      .eq('type', 'mcp')
  }

  findMcpConfig(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select(
        'id, user_id, connections_mcp(server_url, auth_type, auth_credential, auth_header_name, extra_headers)',
      )
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single()
  }

  findPreferredTrafficConnection(
    connectionId: string,
    userId: string,
    projectId: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type, project_id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .or(`project_id.eq.${projectId},project_id.is.null`)
      .maybeSingle()
  }

  findProjectScopedByType(userId: string, type: string, projectId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, project_id')
      .eq('user_id', userId)
      .eq('type', type)
      .eq('project_id', projectId)
      .limit(1)
      .maybeSingle()
  }

  findStripeConnectionsForProject(userId: string, projectId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type, project_id')
      .eq('user_id', userId)
      .in('type', ['stripe_manual', 'stripe'])
      .or(`project_id.eq.${projectId},project_id.is.null`)
  }

  /** Every Stripe connection for the user (project-scoped + Common). */
  findStripeConnectionsForUser(userId: string) {
    return this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type, project_id')
      .eq('user_id', userId)
      .in('type', ['stripe_manual', 'stripe'])
  }

  insertPosthog(row: {
    connection_id: string
    api_key: string
    project_id: unknown
    host: string
  }) {
    return this.supabaseService.getClient().from('connections_posthog').insert(row)
  }

  insertWebhook(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook')
      .insert({ connection_id: connectionId })
  }

  insertStripeManual(row: {
    connection_id: string
    api_key: string
    stripe_account_id: string
  }) {
    return this.supabaseService.getClient().from('connections_stripe_manual').insert(row)
  }

  insertVercel(row: {
    connection_id: string
    api_token: string
    project_id: unknown
    project_name: unknown
  }) {
    return this.supabaseService.getClient().from('connections_vercel').insert(row)
  }

  insertMcp(row: {
    connection_id: string
    server_url: string
    auth_type: string
    auth_credential: string | null
    auth_header_name: string | null
    extra_headers: string | null
  }) {
    return this.supabaseService.getClient().from('connections_mcp').insert(row)
  }

  insertWebhookKey(row: {
    connection_id: string
    name: string
    key_hash: string
    key_prefix: string
  }) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .insert(row)
      .select()
      .single()
  }

  findWebhookKeysByConnectionId(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .select('id, name, key_prefix, revoked_at, created_at')
      .eq('connection_id', connectionId)
      .order('created_at', { ascending: true })
  }

  revokeWebhookKey(connectionId: string, keyId: string, revokedAt: string) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .update({ revoked_at: revokedAt })
      .eq('id', keyId)
      .eq('connection_id', connectionId)
  }

  insertOAuthCredential(row: {
    connection_id: string
    stripe_account_id: string
    access_token: string
    refresh_token: string | null
    scope: string | null
  }) {
    return this.supabaseService.getClient().from('connections_stripe').insert(row)
  }

  getManualApiKey(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_stripe_manual')
      .select('api_key')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  getConnectAccessToken(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_stripe')
      .select('access_token')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  getManualApiKeyWithUserId(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_stripe_manual')
      .select('api_key, connections!inner(user_id)')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  getManualCredentialByAccount(stripeAccountId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_stripe_manual')
      .select('api_key, connections!inner(user_id)')
      .eq('stripe_account_id', stripeAccountId)
      .limit(1)
      .maybeSingle()
  }

  getOAuthCredentialByAccount(stripeAccountId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_stripe')
      .select('access_token, connections!inner(user_id)')
      .eq('stripe_account_id', stripeAccountId)
      .limit(1)
      .maybeSingle()
  }

  findStripeAccountId(connectionId: string, table: StripeCredentialTable) {
    return this.supabaseService
      .getClient()
      .from(table)
      .select('stripe_account_id')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  findCredentialContext(connectionId: string, table: StripeCredentialTable) {
    return this.supabaseService
      .getClient()
      .from(table)
      .select('stripe_account_id, tracked_product_ids')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  findTrackedProductIds(connectionId: string, table: StripeCredentialTable) {
    return this.supabaseService
      .getClient()
      .from(table)
      .select('tracked_product_ids')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  updateTrackedProductIds(
    connectionId: string,
    table: StripeCredentialTable,
    productIds: string[],
  ) {
    return this.supabaseService
      .getClient()
      .from(table)
      .update({ tracked_product_ids: productIds })
      .eq('connection_id', connectionId)
  }

  findConnectionIdsByStripeAccount(stripeAccountId: string) {
    const client = this.supabaseService.getClient()
    return Promise.all([
      client
        .from('connections_stripe_manual')
        .select('connection_id')
        .eq('stripe_account_id', stripeAccountId),
      client
        .from('connections_stripe')
        .select('connection_id')
        .eq('stripe_account_id', stripeAccountId),
    ])
  }
}
