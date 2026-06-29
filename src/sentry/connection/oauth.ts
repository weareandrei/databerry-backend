import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { ConnectionsRepository } from '../../connections/connections.repository'
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
import {
  fmtFailure,
  fmtOp,
  fmtUpstreamFailure,
} from '../../common/log-helpers'
import { SentryRepository } from './sentry.repository'
import { SentryOAuthClient, SentryOAuthHttpError } from '../sentry-oauth.client'

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
  readonly authBase = 'https://sentry.io'
  // Sentry's integration slug — the lowercase-hyphenated identifier of
  // our Public Integration (e.g. `databerry`, not the long `client_id`
  // hex string). Shown on the integration's settings page in Sentry as
  // "Slug". Required for the install URL to resolve; falls back to
  // `clientId` only so dev environments without it set fail with a
  // clear 404 from Sentry rather than a missing-env crash on startup.
  readonly slug = process.env.SENTRY_INTEGRATION_SLUG ?? process.env.SENTRY_CLIENT_ID!

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly sentryRepository: SentryRepository,
  ) {}

  async getOAuthUrl(userId: string, name?: string): Promise<string> {
    const state = randomBytes(16).toString('hex')

    const { error } = await this.sentryRepository.insertOAuthState({
      state,
      user_id: userId,
      name: name ?? null,
    })

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
    const errorRedirect = (reason: string) =>
      `${this.frontendUrl}/hub/connections?sentry=error&reason=${reason}`

    const { data: stateRow } = await this.sentryRepository.findOAuthStateByState(state)

    if (!stateRow) {
      this.logger.warn(`Sentry OAuth state not found (state=${state})`)
      return errorRedirect('state_invalid')
    }

    const userId = stateRow.user_id as string
    const connectionName = (stateRow.name as string | null) ?? 'Sentry'

    try {
      const oauthClient = new SentryOAuthClient(this.clientId, this.clientSecret)
      let tokens: {
        token: string
        refreshToken: string
        expires_at?: string
        expiresAt?: string
      }
      try {
        tokens = await oauthClient.exchangeAuthorizationCode(installationId, code)
      } catch (err) {
        if (err instanceof SentryOAuthHttpError) {
          this.logger.error(
            fmtUpstreamFailure('Sentry token exchange', err.status, err.body, {
              userId,
              installationId,
            }),
          )
        } else {
          this.logger.error(fmtFailure('Sentry token exchange', err, { userId, installationId }))
        }
        return errorRedirect('token_exchange')
      }

      const expiresAtIso = tokens.expires_at ?? tokens.expiresAt
      if (!expiresAtIso) {
        this.logger.error('Sentry token response missing expires_at field')
        return errorRedirect('token_exchange')
      }

      let installData: { organization?: { slug: string } }
      try {
        installData = await oauthClient.getInstallation(installationId, tokens.token)
      } catch (err) {
        if (err instanceof SentryOAuthHttpError) {
          this.logger.error(
            fmtUpstreamFailure('Sentry install lookup', err.status, err.body, {
              userId,
              installationId,
            }),
          )
        } else {
          this.logger.error(fmtFailure('Sentry install lookup', err, { userId, installationId }))
        }
        return errorRedirect('account_resolve')
      }
      const orgSlug = installData.organization?.slug
      if (!orgSlug) {
        this.logger.error(
          'Sentry install lookup response missing organization.slug',
        )
        return errorRedirect('account_resolve')
      }

      // Step 5 — persist. Same shape as `connections_calendly`.
      const { data: conn, error: connErr } = await this.connectionsRepository.insert({
        name: connectionName,
        type: 'sentry',
        user_id: userId,
      })

      if (connErr) {
        this.logger.error(
          fmtFailure('Sentry create connection row', connErr, { userId }),
        )
        return errorRedirect('credentials_save')
      }

      const { error: credErr } = await this.sentryRepository.insert({
        connection_id: conn.id,
        access_token: encryptForUser(tokens.token, userId),
        refresh_token: encryptForUser(tokens.refreshToken, userId),
        expires_at: expiresAtIso,
        org_slug: orgSlug,
        installation_id: installationId,
      })

      if (credErr) {
        this.logger.error(
          fmtFailure('Sentry insert credentials', credErr, {
            userId,
            connectionId: conn.id,
          }),
        )
        await this.connectionsRepository.deleteById(conn.id)
        return errorRedirect('credentials_save')
      }

      this.logger.log(
        fmtOp('Sentry connected', {
          userId,
          connectionId: conn.id,
          orgSlug,
        }),
      )
      return `${this.frontendUrl}/hub/connections?sentry=connected`
    } finally {
      await this.sentryRepository.deleteOAuthStateByState(state)
    }
  }

  /**
   * Returns a fresh access token, refreshing in-place when the cached
   * one is within 5 minutes of expiry. Mirrors Calendly's pattern.
   */
  async ensureFreshToken(connectionId: string): Promise<string> {
    const { data, error } = await this.sentryRepository.findWithUserJoin(connectionId)

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
    let tokens: {
      token: string
      refreshToken: string
      expires_at?: string
      expiresAt?: string
    }
    try {
      tokens = await new SentryOAuthClient(this.clientId, this.clientSecret).refreshAccessToken(
        installationId,
        refreshToken,
      )
    } catch (err) {
      if (err instanceof SentryOAuthHttpError) {
        const detail = err.body
        if (err.status >= 500) {
          this.logger.warn(
            `Sentry refresh upstream error (${err.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
          )
          throw new IntegrationUpstreamException(
            'sentry',
            connectionId,
            `Sentry token endpoint returned ${err.status}`,
          )
        }
        this.logger.warn(
          `Sentry refresh failed for connection ${connectionId} (${err.status}): ${detail.slice(0, 200)}`,
        )
        throw new IntegrationReauthRequiredException('sentry', connectionId)
      }
      this.logger.warn(`Sentry refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'sentry',
        connectionId,
        'Could not reach Sentry token endpoint',
      )
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
    await this.sentryRepository.updateTokens(connectionId, {
      access_token: encryptForUser(tokens.token, userId),
      refresh_token: encryptForUser(tokens.refreshToken, userId),
      expires_at: newExpiresAt,
    })

    return tokens.token
  }

  async getOrgSlug(connectionId: string): Promise<string> {
    const { data } = await this.sentryRepository.findOrgSlug(connectionId)

    if (!data) throw new NotFoundException('Sentry credentials not found')
    return data.org_slug as string
  }

  async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.connectionsRepository.findIdByConnectionAndUser(
      connectionId,
      userId,
    )

    if (!data) throw new ConnectionMissingException('sentry', connectionId)
  }
}
