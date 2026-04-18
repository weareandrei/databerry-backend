import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { SupabaseService } from '../../supabase/supabase.service'

export interface GAProperty {
  id: string
  name: string
  displayName: string
}

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

@Injectable()
export class GoogleAnalyticsOAuthService {
  private readonly logger = new Logger(GoogleAnalyticsOAuthService.name)

  readonly clientId = process.env.GA_CLIENT_ID!
  readonly clientSecret = process.env.GA_CLIENT_SECRET!
  readonly frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'

  constructor(private readonly supabaseService: SupabaseService) {}

  async getOAuthUrl(userId: string, redirectUri: string): Promise<string> {
    const state = randomBytes(16).toString('hex')
    await this.supabaseService
      .getClient()
      .from('google_analytics_oauth_state')
      .insert({ state, user_id: userId })

    const url = new URL(AUTH_URL)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/analytics.readonly')
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    return url.toString()
  }

  async handleOAuthCallback(code: string, state: string, redirectUri: string): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data: stateRow } = await client
      .from('google_analytics_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()

    if (!stateRow) return `${this.frontendUrl}/hub/connections?google_analytics=error`

    const userId = stateRow.user_id as string

    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })
      if (!tokenRes.ok) {
        this.logger.error('GA token exchange failed', await tokenRes.text())
        return `${this.frontendUrl}/hub/connections?google_analytics=error`
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      const properties = await this.listPropertiesWithToken(tokens.access_token)

      const { data: conn, error: connErr } = await client
        .from('connections')
        .insert({ name: 'Google Analytics', type: 'google_analytics', user_id: userId })
        .select()
        .single()

      if (connErr) throw new Error('Failed to create connection: ' + connErr.message)

      const firstProperty = properties.length === 1 ? properties[0] : null

      await client.from('connections_google_analytics').insert({
        connection_id: conn.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokenExpiry,
        property_id: firstProperty?.id ?? null,
        property_name: firstProperty?.displayName ?? null,
      })

      this.logger.log(`GA connected for user ${userId}, propertyId=${firstProperty?.id ?? 'none yet'}`)

      if (!firstProperty && properties.length === 0) {
        return `${this.frontendUrl}/hub/connections?google_analytics=no-properties`
      }

      if (properties.length > 1) {
        return `${this.frontendUrl}/hub/connections?google_analytics=select-property&connectionId=${conn.id}`
      }

      return `${this.frontendUrl}/hub/connections?google_analytics=connected`
    } finally {
      await client.from('google_analytics_oauth_state').delete().eq('state', state)
    }
  }

  async ensureFreshToken(connectionId: string): Promise<string> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .select('access_token, refresh_token, token_expiry')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Google Analytics credentials not found')

    const expiry = new Date(data.token_expiry as string)
    const buffer = new Date(Date.now() + 5 * 60 * 1000)

    if (expiry > buffer) return data.access_token as string

    this.logger.log(`Refreshing GA token for connection ${connectionId}`)
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token as string,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })
    if (!res.ok) throw new UnauthorizedException('Failed to refresh Google Analytics token')

    const tokens = (await res.json()) as { access_token: string; expires_in: number }
    const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    await this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .update({ access_token: tokens.access_token, token_expiry: newExpiry })
      .eq('connection_id', connectionId)

    return tokens.access_token
  }

  async getPropertyId(connectionId: string): Promise<string> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .select('property_id')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data?.property_id) {
      throw new NotFoundException(
        'No GA4 property configured for this connection. Select a property first.',
      )
    }
    return data.property_id as string
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

  async listPropertiesWithToken(token: string): Promise<GAProperty[]> {
    const all: GAProperty[] = []
    try {
      const accRes = await fetch(`${ADMIN_BASE}/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!accRes.ok) {
        this.logger.warn('Failed to list GA accounts: ' + (await accRes.text()))
        return []
      }
      const accData = (await accRes.json()) as { accounts?: { name: string }[] }

      for (const account of accData.accounts ?? []) {
        const propRes = await fetch(
          `${ADMIN_BASE}/properties?filter=ancestor:${account.name}&pageSize=200`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!propRes.ok) continue
        const propData = (await propRes.json()) as {
          properties?: { name: string; displayName: string }[]
        }
        for (const p of propData.properties ?? []) {
          const id = p.name.split('/').pop()!
          all.push({ id, name: p.name, displayName: p.displayName })
        }
      }
    } catch (err) {
      this.logger.error('Error listing GA properties', err)
    }
    return all
  }
}
