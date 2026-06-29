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
  type LogContext,
} from '../../common/log-helpers'
import { GoogleAnalyticsRepository } from './google-analytics.repository'
import {
  GoogleAnalyticsAdminClient,
  type GAProperty,
} from '../google-analytics-admin.client'
import { GoogleOAuthClient, GoogleOAuthHttpError } from '../google-oauth.client'

export type { GAProperty }

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

@Injectable()
export class GoogleAnalyticsOAuthService {
  private readonly logger = new Logger(GoogleAnalyticsOAuthService.name)

  readonly clientId = process.env.GA_CLIENT_ID!
  readonly clientSecret = process.env.GA_CLIENT_SECRET!
  readonly frontendUrl = getPrimaryFrontendUrl()

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly gaRepository: GoogleAnalyticsRepository,
  ) {}

  async getOAuthUrl(userId: string, redirectUri: string): Promise<string> {
    const state = randomBytes(16).toString('hex')
    await this.gaRepository.insertOAuthState({ state, user_id: userId })

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
    // Tiny helper so each failure path stays a one-liner. Reason
    // codes match `OAuthFailureReason` from
    // `stripe/connection/oauth.ts`. Note we keep the existing
    // `no-properties` and `select-property` flows untouched — those
    // are *successful* terminal states (not errors), they just need
    // the user to do one more thing on our side. Only the error
    // paths grow `&reason=…`.
    const errorRedirect = (reason: string) =>
      `${this.frontendUrl}/hub/connections?google_analytics=error&reason=${reason}`

    const { data: stateRow } = await this.gaRepository.findOAuthStateByState(state)

    if (!stateRow) {
      this.logger.warn(`GA OAuth state not found (state=${state})`)
      return errorRedirect('state_invalid')
    }

    const userId = stateRow.user_id as string

    try {
      const oauthClient = new GoogleOAuthClient(this.clientId, this.clientSecret)
      let tokens: { access_token: string; refresh_token?: string; expires_in: number }
      try {
        tokens = await oauthClient.exchangeAuthorizationCode(code, redirectUri)
      } catch (err) {
        if (err instanceof GoogleOAuthHttpError) {
          this.logger.error(
            fmtUpstreamFailure('GA token exchange', err.status, err.body, { userId }),
          )
        } else {
          this.logger.error(fmtFailure('GA token exchange', err, { userId }))
        }
        return errorRedirect('token_exchange')
      }

      if (!tokens.refresh_token) {
        this.logger.error('GA token exchange missing refresh_token')
        return errorRedirect('token_exchange')
      }

      const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      let properties: GAProperty[]
      try {
        properties = await new GoogleAnalyticsAdminClient(tokens.access_token).listProperties({
          userId,
        })
      } catch (err) {
        this.logger.error(fmtFailure('GA listProperties (post-OAuth)', err, { userId }))
        return errorRedirect('account_resolve')
      }

      const { data: conn, error: connErr } = await this.connectionsRepository.insert({
        name: 'Google Analytics',
        type: 'google_analytics',
        user_id: userId,
      })

      if (connErr) {
        this.logger.error(
          fmtFailure('GA create connection row', connErr, { userId }),
        )
        return errorRedirect('credentials_save')
      }

      const firstProperty = properties.length === 1 ? properties[0] : null

      // Encrypt OAuth tokens with the per-user envelope before write.
      // See `common/crypto/encryption.ts` for the algorithm rationale.
      // We have `userId` in scope from the OAuth state row, which is
      // exactly what the per-user key derivation needs.
      const { error: credErr } = await this.gaRepository.insert({
        connection_id: conn.id,
        access_token: encryptForUser(tokens.access_token, userId),
        refresh_token: encryptForUser(tokens.refresh_token, userId),
        token_expiry: tokenExpiry,
        property_id: firstProperty?.id ?? null,
        property_name: firstProperty?.displayName ?? null,
      })

      if (credErr) {
        this.logger.error(
          fmtFailure('GA insert credentials', credErr, {
            userId,
            connectionId: conn.id,
          }),
        )
        // Roll back the parent row so we don't leave an orphan.
        await this.connectionsRepository.deleteById(conn.id)
        return errorRedirect('credentials_save')
      }

      this.logger.log(
        fmtOp('GA connected', {
          userId,
          connectionId: conn.id,
          propertyId: firstProperty?.id ?? 'none-yet',
        }),
      )

      if (!firstProperty && properties.length === 0) {
        return `${this.frontendUrl}/hub/connections?google_analytics=no-properties`
      }

      if (properties.length > 1) {
        return `${this.frontendUrl}/hub/connections?google_analytics=select-property&connectionId=${conn.id}`
      }

      return `${this.frontendUrl}/hub/connections?google_analytics=connected`
    } finally {
      await this.gaRepository.deleteOAuthStateByState(state)
    }
  }

  async ensureFreshToken(connectionId: string): Promise<string> {
    // Pull the parent connection's `user_id` alongside the credentials
    // — the per-user encryption envelope needs the UUID to derive the
    // decryption key. The `connections!inner(user_id)` syntax is
    // PostgREST's "embed-via-FK" notation; the `inner` flavour means
    // we get null instead of an empty array if the FK is dangling
    // (which we already special-case as `!data` below).
    const { data, error } = await this.gaRepository.findWithUserJoin(connectionId)

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

    // Supabase returns embedded one-to-one relations as either an
    // array or a plain object depending on uniqueness inference;
    // normalise.
    const userId = (
      Array.isArray(data.connections) ? data.connections[0] : data.connections
    )?.user_id as string | undefined
    if (!userId) {
      this.logger.error(`GA credentials orphaned (no user_id) for connection ${connectionId}`)
      throw new NotFoundException('Google Analytics credentials not found')
    }

    // Decrypt-on-read with a plaintext fallback for rows that pre-date
    // the encryption migration. The migration script flips every row
    // to `v1:` afterwards; once we're confident no plaintext rows
    // remain, this fallback can be removed in a follow-up.
    const accessTokenRaw = data.access_token as string
    const refreshTokenRaw = data.refresh_token as string
    const accessToken = isEncrypted(accessTokenRaw)
      ? decryptForUser(accessTokenRaw, userId)
      : accessTokenRaw
    const refreshToken = isEncrypted(refreshTokenRaw)
      ? decryptForUser(refreshTokenRaw, userId)
      : refreshTokenRaw

    const expiry = new Date(data.token_expiry as string)
    const buffer = new Date(Date.now() + 5 * 60 * 1000)

    if (expiry > buffer) {
      const minsLeft = Math.round((expiry.getTime() - Date.now()) / 60_000)
      this.logger.log(`GA token still fresh for ${connectionId} (${minsLeft}m left, no refresh)`)
      return accessToken
    }

    this.logger.log(`Refreshing GA token for connection ${connectionId}`)
    let tokens: { access_token: string; expires_in: number }
    try {
      tokens = await new GoogleOAuthClient(this.clientId, this.clientSecret).refreshAccessToken(
        refreshToken,
      )
    } catch (err) {
      if (err instanceof GoogleOAuthHttpError) {
        const detail = err.body
        if (err.status >= 500) {
          this.logger.warn(
            `GA refresh upstream error (${err.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
          )
          throw new IntegrationUpstreamException(
            'google_analytics',
            connectionId,
            `Google token endpoint returned ${err.status}`,
          )
        }
        this.logger.warn(
          `GA refresh failed for connection ${connectionId} (${err.status}): ${detail.slice(0, 200)}`,
        )
        throw new IntegrationReauthRequiredException('google_analytics', connectionId)
      }
      this.logger.warn(`GA refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'google_analytics',
        connectionId,
        'Could not reach Google token endpoint',
      )
    }
    const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Re-encrypt the rotated access_token before write — Google's
    // refresh response only returns a new access_token (refresh_token
    // is re-used), so we only update the one column. `userId` is
    // already in scope from the join above.
    await this.gaRepository.updateTokens(connectionId, {
      access_token: encryptForUser(tokens.access_token, userId),
      token_expiry: newExpiry,
    })

    this.logger.log(
      `✓ Refreshed GA token for ${connectionId} (expires_in=${tokens.expires_in}s, new_expiry=${newExpiry})`,
    )
    return tokens.access_token
  }

  async getPropertyId(connectionId: string): Promise<string> {
    const { data } = await this.gaRepository.findPropertyId(connectionId)

    if (!data?.property_id) {
      throw new NotFoundException(
        'No GA4 property configured for this connection. Select a property first.',
      )
    }
    return data.property_id as string
  }

  async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.connectionsRepository.findIdByConnectionAndUser(
      connectionId,
      userId,
    )

    // 410 (not 404) so the per-view live-value tile can render the inline
    // "Reconnect" → reassign-connection-dialog flow instead of a generic
    // "Couldn't load value" badge. Same shape as the reauth path; see
    // `frontend/lib/api.ts#ConnectionMissingError`.
    if (!data) throw new ConnectionMissingException('google_analytics', connectionId)
  }

  async listPropertiesWithToken(token: string, ctx: LogContext = {}): Promise<GAProperty[]> {
    return new GoogleAnalyticsAdminClient(token).listProperties(ctx)
  }
}
