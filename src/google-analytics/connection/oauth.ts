import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { SupabaseService } from '../../supabase/supabase.service'
import {
  ConnectionMissingException,
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../common/integration-errors'
import { getPrimaryFrontendUrl } from '../../common/frontend-url'

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
  readonly frontendUrl = getPrimaryFrontendUrl()

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

    // Tiny helper so each failure path stays a one-liner. Reason
    // codes match `OAuthFailureReason` from
    // `stripe/connection/oauth.ts`. Note we keep the existing
    // `no-properties` and `select-property` flows untouched — those
    // are *successful* terminal states (not errors), they just need
    // the user to do one more thing on our side. Only the error
    // paths grow `&reason=…`.
    const errorRedirect = (reason: string) =>
      `${this.frontendUrl}/hub/connections?google_analytics=error&reason=${reason}`

    const { data: stateRow } = await client
      .from('google_analytics_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()

    if (!stateRow) {
      this.logger.warn(`GA OAuth state not found (state=${state})`)
      return errorRedirect('state_invalid')
    }

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
        return errorRedirect('token_exchange')
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      let properties: GAProperty[]
      try {
        properties = await this.listPropertiesWithToken(tokens.access_token)
      } catch (err) {
        this.logger.error(
          `GA listProperties failed for user ${userId}: ${String(err)}`,
        )
        return errorRedirect('account_resolve')
      }

      const { data: conn, error: connErr } = await client
        .from('connections')
        .insert({ name: 'Google Analytics', type: 'google_analytics', user_id: userId })
        .select()
        .single()

      if (connErr) {
        this.logger.error(
          `GA: failed to create connection row for user ${userId}: ${connErr.message}`,
        )
        return errorRedirect('credentials_save')
      }

      const firstProperty = properties.length === 1 ? properties[0] : null

      const { error: credErr } = await client.from('connections_google_analytics').insert({
        connection_id: conn.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokenExpiry,
        property_id: firstProperty?.id ?? null,
        property_name: firstProperty?.displayName ?? null,
      })

      if (credErr) {
        this.logger.error(
          `GA: failed to insert credentials for connection ${conn.id}: ${credErr.message}`,
        )
        // Roll back the parent row so we don't leave an orphan.
        await client.from('connections').delete().eq('id', conn.id)
        return errorRedirect('credentials_save')
      }

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
    const client = this.supabaseService.getClient()

    const { data, error } = await client
      .from('connections_google_analytics')
      .select('access_token, refresh_token, token_expiry')
      .eq('connection_id', connectionId)
      .maybeSingle()

    // Distinguish three cases that previously all looked like "row missing":
    //   1. Supabase returned an actual error (missing column, network blip,
    //      schema cache miss). data is null AND error is set.
    //   2. Query succeeded but no row matched — orphaned connections row.
    //      data is null and error is null.
    //   3. Row found — proceed.
    if (error) {
      this.logger.error(
        `GA credentials lookup errored for connection ${connectionId}: ` +
          `code=${error.code ?? '?'} message=${error.message} details=${error.details ?? ''} hint=${error.hint ?? ''}`,
      )
      throw new NotFoundException('Google Analytics credentials lookup failed')
    }
    if (!data) {
      this.logger.warn(`GA credentials row missing for connection ${connectionId}`)
      throw new NotFoundException('Google Analytics credentials not found')
    }

    const expiry = new Date(data.token_expiry as string)
    const buffer = new Date(Date.now() + 5 * 60 * 1000)

    if (expiry > buffer) {
      const minsLeft = Math.round((expiry.getTime() - Date.now()) / 60_000)
      this.logger.log(`GA token still fresh for ${connectionId} (${minsLeft}m left, no refresh)`)
      return data.access_token as string
    }

    this.logger.log(`Refreshing GA token for connection ${connectionId}`)
    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
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
      // Network failure reaching Google. Don't mark the row as
      // needs_reauth — the refresh token might be perfectly fine; we
      // just couldn't ask. Surface as upstream so the user sees a
      // transient-error UX, not a misleading "reconnect" prompt.
      this.logger.warn(`GA refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'google_analytics',
        connectionId,
        'Could not reach Google token endpoint',
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')

      // Google returns 5xx for its own outages — those are transient. 4xx
      // (typically `invalid_grant`) is the canonical "this refresh token
      // is dead" signal: revoked by the user, scope changed, or — most
      // commonly for us — the GA OAuth app is in "Testing" status and
      // Google nuked the refresh token after 7 days.
      if (res.status >= 500) {
        this.logger.warn(
          `GA refresh upstream error (${res.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
        )
        throw new IntegrationUpstreamException(
          'google_analytics',
          connectionId,
          `Google token endpoint returned ${res.status}`,
        )
      }

      this.logger.warn(
        `GA refresh failed for connection ${connectionId} (${res.status}): ${detail.slice(0, 200)}`,
      )
      // Refresh token is dead. Surface the structured error so the
      // frontend renders the "Reconnect" banner. We don't mark anything
      // in the DB — every subsequent request will re-attempt the refresh
      // and 4xx again, which costs ~200ms and a Google API call, but
      // saves a column and a migration. At our scale that trade is fine;
      // revisit if a single broken connection ever generates enough
      // refresh churn to matter.
      throw new IntegrationReauthRequiredException('google_analytics', connectionId)
    }

    const tokens = (await res.json()) as { access_token: string; expires_in: number }
    const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    await client
      .from('connections_google_analytics')
      .update({
        access_token: tokens.access_token,
        token_expiry: newExpiry,
      })
      .eq('connection_id', connectionId)

    this.logger.log(
      `✓ Refreshed GA token for ${connectionId} (expires_in=${tokens.expires_in}s, new_expiry=${newExpiry})`,
    )
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

    // 410 (not 404) so the per-view live-value tile can render the inline
    // "Reconnect" → reassign-connection-dialog flow instead of a generic
    // "Couldn't load value" badge. Same shape as the reauth path; see
    // `frontend/lib/api.ts#ConnectionMissingError`.
    if (!data) throw new ConnectionMissingException('google_analytics', connectionId)
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
