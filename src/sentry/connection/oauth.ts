import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { SupabaseService } from '../../supabase/supabase.service'
import {
  ConnectionMissingException,
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../common/integration-errors'
import { getPrimaryFrontendUrl } from '../../common/frontend-url'
import {
  decryptForUser,
  encryptForUser,
  isEncrypted,
} from '../../common/crypto/encryption'

/**
 * Sentry's OAuth flow is shaped a bit differently from Calendly /
 * Google's. They call it a "Public Integration" — the user installs
 * the integration into their Sentry org rather than authorising a
 * single user, so the auth dance is:
 *
 *   1. Frontend opens `https://sentry.io/sentry-apps/<slug>/external-install/`
 *      (or, if our integration is published, the standard
 *      `/oauth/authorize/`). For unpublished integrations the
 *      external-install URL is what works for any org admin.
 *      We pass `state` so we can match the redirect back to the user.
 *   2. User picks an org + clicks "Install".
 *   3. Sentry redirects to our `redirect_uri?code=<>&installationId=<>&state=<>`.
 *   4. We POST to `/api/0/sentry-app-installations/{installationId}/authorizations/`
 *      with `client_id`, `client_secret`, `grant_type=authorization_code`,
 *      `code`. Returns `access_token`, `refresh_token`, `expires_at`.
 *   5. Refresh later: POST same endpoint with `grant_type=refresh_token`.
 *
 * Tokens are short-lived (8 hours per Sentry docs); refresh rotates
 * the refresh token.
 *
 * Spec / reference docs we used:
 *   - https://docs.sentry.io/api/integrations/auth-tokens/
 *   - https://docs.sentry.io/organization/integrations/integration-platform/
 */
@Injectable()
export class SentryOAuthService {
  private readonly logger = new Logger(SentryOAuthService.name)

  readonly clientId = process.env.SENTRY_CLIENT_ID!
  readonly clientSecret = process.env.SENTRY_CLIENT_SECRET!
  readonly redirectUri = `${process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3001'}/sentry/oauth/callback`
  readonly frontendUrl = getPrimaryFrontendUrl()
  readonly baseApi = 'https://sentry.io/api/0'
  readonly authBase = 'https://sentry.io'
  // Sentry's integration slug — the lowercase-hyphenated identifier of
  // our Public Integration (e.g. `databerry`, not the long `client_id`
  // hex string). Shown on the integration's settings page in Sentry as
  // "Slug". Required for the install URL to resolve; falls back to
  // `clientId` only so dev environments without it set fail with a
  // clear 404 from Sentry rather than a missing-env crash on startup.
  readonly slug = process.env.SENTRY_INTEGRATION_SLUG ?? process.env.SENTRY_CLIENT_ID!

  constructor(private readonly supabaseService: SupabaseService) {}

  async getOAuthUrl(userId: string, name?: string): Promise<string> {
    const state = randomBytes(16).toString('hex')

    const { error } = await this.supabaseService
      .getClient()
      .from('sentry_oauth_state')
      .insert({ state, user_id: userId, name: name ?? null })

    if (error) {
      this.logger.error(
        `Failed to store Sentry OAuth state for user ${userId}: ${error.message}`,
      )
      throw new Error('Failed to store OAuth state: ' + error.message)
    }

    // Sentry's external-install URL — works for both published and
    // unpublished integrations. Uses the integration's slug (lowercase-
    // hyphenated name), which is distinct from the OAuth `client_id` —
    // see the `slug` field for env-var wiring.
    const url = new URL(`${this.authBase}/sentry-apps/${this.slug}/external-install/`)
    url.searchParams.set('state', state)

    return url.toString()
  }

  /**
   * Sentry's install redirect URL shape:
   *   `<redirect_uri>?installationId=<uuid>&code=<>&state=<>`
   *
   * `installationId` is unique per (org, integration) pair and is
   * required for every subsequent token-refresh call. We store it on
   * the connection row.
   */
  async handleOAuthCallback(
    code: string,
    state: string,
    installationId: string,
  ): Promise<string> {
    const client = this.supabaseService.getClient()

    const errorRedirect = (reason: string) =>
      `${this.frontendUrl}/hub/connections?sentry=error&reason=${reason}`

    const { data: stateRow } = await client
      .from('sentry_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()

    if (!stateRow) {
      this.logger.warn(`Sentry OAuth state not found (state=${state})`)
      return errorRedirect('state_invalid')
    }

    const userId = stateRow.user_id as string
    const connectionName = (stateRow.name as string | null) ?? 'Sentry'

    try {
      // Step 4 — exchange code for tokens. Sentry's token endpoint
      // lives under the installation, NOT under `/oauth/token` like
      // most providers.
      const tokenRes = await fetch(
        `${this.baseApi}/sentry-app-installations/${installationId}/authorizations/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }),
        },
      )

      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '')
        this.logger.error(
          `Sentry token exchange failed (${tokenRes.status}): ${body.slice(0, 200)}`,
        )
        return errorRedirect('token_exchange')
      }

      const tokens = (await tokenRes.json()) as {
        token: string
        refreshToken: string
        // Sentry returns `expires_at` as ISO timestamp (NOT
        // `expires_in` seconds like most providers).
        expires_at?: string
        expiresAt?: string
      }
      const expiresAtIso = tokens.expires_at ?? tokens.expiresAt
      if (!expiresAtIso) {
        this.logger.error('Sentry token response missing expires_at field')
        return errorRedirect('token_exchange')
      }

      // Step 4b — resolve the org slug. The install-details endpoint
      // (`/api/0/sentry-app-installations/{id}/`) requires the
      // integration to authenticate as itself (HTTP Basic with client
      // credentials), NOT the user-scoped access token we just got —
      // hitting it with the bearer returns 403. Easier route: ask
      // `/api/0/organizations/` which orgs this token can see; the
      // installation token is scoped to exactly one org (the installer's),
      // so the response is a single-entry array whose `slug` is what
      // we need. Uses the `org:read` scope our integration already
      // requests, no extra permissions required.
      const orgsRes = await fetch(`${this.baseApi}/organizations/`, {
        headers: { Authorization: `Bearer ${tokens.token}` },
      })
      if (!orgsRes.ok) {
        const detail = await orgsRes.text().catch(() => '')
        this.logger.error(
          `Sentry org lookup failed (${orgsRes.status}): ${detail.slice(0, 200)}`,
        )
        return errorRedirect('account_resolve')
      }
      const orgs = (await orgsRes.json()) as Array<{ slug: string }>
      if (!orgs.length) {
        this.logger.error('Sentry org lookup returned an empty array')
        return errorRedirect('account_resolve')
      }
      const orgSlug = orgs[0].slug

      // Step 5 — persist. Same shape as `connections_calendly`.
      const { data: conn, error: connErr } = await client
        .from('connections')
        .insert({ name: connectionName, type: 'sentry', user_id: userId })
        .select()
        .single()

      if (connErr) {
        this.logger.error(
          `Sentry: failed to create connection row for user ${userId}: ${connErr.message}`,
        )
        return errorRedirect('credentials_save')
      }

      const { error: credErr } = await client.from('connections_sentry').insert({
        connection_id: conn.id,
        access_token: encryptForUser(tokens.token, userId),
        refresh_token: encryptForUser(tokens.refreshToken, userId),
        expires_at: expiresAtIso,
        org_slug: orgSlug,
        installation_id: installationId,
      })

      if (credErr) {
        this.logger.error(
          `Sentry: failed to insert credentials for connection ${conn.id}: ${credErr.message}`,
        )
        await client.from('connections').delete().eq('id', conn.id)
        return errorRedirect('credentials_save')
      }

      this.logger.log(`Sentry connected for user ${userId}, org ${orgSlug}`)
      return `${this.frontendUrl}/hub/connections?sentry=connected`
    } finally {
      await client.from('sentry_oauth_state').delete().eq('state', state)
    }
  }

  /**
   * Returns a fresh access token, refreshing in-place when the cached
   * one is within 5 minutes of expiry. Mirrors Calendly's pattern.
   */
  async ensureFreshToken(connectionId: string): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data, error } = await client
      .from('connections_sentry')
      .select(
        'access_token, refresh_token, expires_at, installation_id, connections!inner(user_id)',
      )
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (error) {
      this.logger.error(
        `Sentry credentials lookup errored for connection ${connectionId}: ${error.message}`,
      )
      throw new NotFoundException('Sentry credentials lookup failed')
    }
    if (!data) {
      this.logger.warn(`Sentry credentials missing for connection ${connectionId}`)
      throw new NotFoundException('Sentry credentials not found')
    }

    const userId = (
      Array.isArray(data.connections) ? data.connections[0] : data.connections
    )?.user_id as string | undefined
    if (!userId) {
      this.logger.error(`Sentry credentials orphaned (no user_id) for ${connectionId}`)
      throw new NotFoundException('Sentry credentials not found')
    }

    const accessTokenRaw = data.access_token as string
    const refreshTokenRaw = data.refresh_token as string
    const accessToken = isEncrypted(accessTokenRaw)
      ? decryptForUser(accessTokenRaw, userId)
      : accessTokenRaw
    const refreshToken = isEncrypted(refreshTokenRaw)
      ? decryptForUser(refreshTokenRaw, userId)
      : refreshTokenRaw

    const expiresAt = new Date(data.expires_at as string)
    const bufferTime = new Date(Date.now() + 5 * 60 * 1000)

    if (expiresAt > bufferTime) {
      return accessToken
    }

    this.logger.log(`Refreshing Sentry token for connection ${connectionId}`)

    const installationId = data.installation_id as string
    let tokenRes: Response
    try {
      tokenRes = await fetch(
        `${this.baseApi}/sentry-app-installations/${installationId}/authorizations/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }),
        },
      )
    } catch (err) {
      this.logger.warn(`Sentry refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'sentry',
        connectionId,
        'Could not reach Sentry token endpoint',
      )
    }

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '')
      if (tokenRes.status >= 500) {
        this.logger.warn(
          `Sentry refresh upstream error (${tokenRes.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
        )
        throw new IntegrationUpstreamException(
          'sentry',
          connectionId,
          `Sentry token endpoint returned ${tokenRes.status}`,
        )
      }
      this.logger.warn(
        `Sentry refresh failed for connection ${connectionId} (${tokenRes.status}): ${detail.slice(0, 200)}`,
      )
      throw new IntegrationReauthRequiredException('sentry', connectionId)
    }

    const tokens = (await tokenRes.json()) as {
      token: string
      refreshToken: string
      expires_at?: string
      expiresAt?: string
    }
    const newExpiresAt = tokens.expires_at ?? tokens.expiresAt
    if (!newExpiresAt) {
      throw new IntegrationUpstreamException(
        'sentry',
        connectionId,
        'Sentry refresh response missing expires_at',
      )
    }

    // Re-encrypt — Sentry rotates the refresh token on every refresh.
    await client
      .from('connections_sentry')
      .update({
        access_token: encryptForUser(tokens.token, userId),
        refresh_token: encryptForUser(tokens.refreshToken, userId),
        expires_at: newExpiresAt,
      })
      .eq('connection_id', connectionId)

    return tokens.token
  }

  async getOrgSlug(connectionId: string): Promise<string> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections_sentry')
      .select('org_slug')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Sentry credentials not found')
    return data.org_slug as string
  }

  async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!data) throw new ConnectionMissingException('sentry', connectionId)
  }
}
