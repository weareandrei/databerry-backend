import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
import { SupabaseService } from '../../supabase/supabase.service'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../common/integration-errors'

@Injectable()
export class CalendlyOAuthService {
  private readonly logger = new Logger(CalendlyOAuthService.name)

  readonly clientId = process.env.CALENDLY_CLIENT_ID!
  readonly clientSecret = process.env.CALENDLY_CLIENT_SECRET!
  readonly redirectUri = `${process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3001'}/calendly/oauth/callback`
  readonly frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
  readonly baseApi = 'https://api.calendly.com'
  readonly authBase = 'https://auth.calendly.com'

  constructor(private readonly supabaseService: SupabaseService) {}

  async getOAuthUrl(userId: string): Promise<string> {
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')

    const { error } = await this.supabaseService
      .getClient()
      .from('calendly_oauth_state')
      .insert({ state, user_id: userId, code_verifier: codeVerifier })

    if (error) throw new Error('Failed to store OAuth state: ' + error.message)

    const url = new URL(`${this.authBase}/oauth/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)

    return url.toString()
  }

  async handleOAuthCallback(code: string, state: string): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data: stateRow } = await client
      .from('calendly_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()

    if (!stateRow) {
      return `${this.frontendUrl}/hub/connections?calendly=error`
    }

    const userId = stateRow.user_id as string
    const codeVerifier = stateRow.code_verifier as string

    try {
      const tokenRes = await fetch(`${this.authBase}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code_verifier: codeVerifier,
        }),
      })

      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}))
        this.logger.error('Token exchange failed', body)
        return `${this.frontendUrl}/hub/connections?calendly=error`
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      const meRes = await fetch(`${this.baseApi}/users/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })

      if (!meRes.ok) throw new Error('Failed to fetch Calendly user info')
      const me = (await meRes.json()) as {
        resource: { uri: string; current_organization: string }
      }

      const { data: conn, error: connErr } = await client
        .from('connections')
        .insert({ name: 'Calendly', type: 'calendly', user_id: userId })
        .select()
        .single()

      if (connErr) throw new Error('Failed to create connection: ' + connErr.message)

      const { error: credErr } = await client.from('connections_calendly').insert({
        connection_id: conn.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        user_uri: me.resource.uri,
        organization_uri: me.resource.current_organization,
      })

      if (credErr) throw new Error('Failed to store credentials: ' + credErr.message)

      this.logger.log(`Calendly connected for user ${userId}`)
      return `${this.frontendUrl}/hub/connections?calendly=connected`
    } finally {
      await client.from('calendly_oauth_state').delete().eq('state', state)
    }
  }

  async ensureFreshToken(connectionId: string): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data, error } = await client
      .from('connections_calendly')
      .select('access_token, refresh_token, expires_at')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (error) {
      this.logger.error(
        `Calendly credentials lookup errored for connection ${connectionId}: ` +
          `code=${error.code ?? '?'} message=${error.message} details=${error.details ?? ''} hint=${error.hint ?? ''}`,
      )
      throw new NotFoundException('Calendly credentials lookup failed')
    }
    if (!data) {
      this.logger.warn(`Calendly credentials row missing for connection ${connectionId}`)
      throw new NotFoundException('Calendly credentials not found')
    }

    const expiresAt = new Date(data.expires_at as string)
    const bufferTime = new Date(Date.now() + 5 * 60 * 1000)

    if (expiresAt > bufferTime) {
      return data.access_token as string
    }

    this.logger.log(`Refreshing Calendly token for connection ${connectionId}`)

    let tokenRes: Response
    try {
      tokenRes = await fetch(`${this.authBase}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: data.refresh_token as string,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
      })
    } catch (err) {
      this.logger.warn(`Calendly refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'calendly',
        connectionId,
        'Could not reach Calendly token endpoint',
      )
    }

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '')

      // 5xx = Calendly outage (transient); 4xx = refresh token is dead.
      if (tokenRes.status >= 500) {
        this.logger.warn(
          `Calendly refresh upstream error (${tokenRes.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
        )
        throw new IntegrationUpstreamException(
          'calendly',
          connectionId,
          `Calendly token endpoint returned ${tokenRes.status}`,
        )
      }

      this.logger.warn(
        `Calendly refresh failed for connection ${connectionId} (${tokenRes.status}): ${detail.slice(0, 200)}`,
      )
      // Refresh token is dead. See the GA equivalent for the rationale on
      // not persisting a status flag — every subsequent request re-attempts
      // and 4xx's again, fine at our scale.
      throw new IntegrationReauthRequiredException('calendly', connectionId)
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Calendly *rotates* refresh tokens on each successful refresh, so we
    // must persist the new one — unlike Google, which reuses the original.
    await client
      .from('connections_calendly')
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: newExpiresAt,
      })
      .eq('connection_id', connectionId)

    return tokens.access_token
  }

  async getUserUri(connectionId: string): Promise<string> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections_calendly')
      .select('user_uri')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Calendly credentials not found')
    return data.user_uri as string
  }

  async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Connection not found')
  }
}
