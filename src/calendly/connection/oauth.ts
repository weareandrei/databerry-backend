import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
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
import { fmtFailure } from '../../common/log-helpers'
import { CalendlyRepository } from './calendly.repository'
import { CalendlyApiClient } from '../calendly-api.client'
import { CalendlyOAuthClient, CalendlyOAuthHttpError } from '../calendly-oauth.client'

@Injectable()
export class CalendlyOAuthService {
  private readonly logger = new Logger(CalendlyOAuthService.name)

  readonly clientId = process.env.CALENDLY_CLIENT_ID!
  readonly clientSecret = process.env.CALENDLY_CLIENT_SECRET!
  readonly redirectUri = `${process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3001'}/calendly/oauth/callback`
  readonly frontendUrl = getPrimaryFrontendUrl()
  readonly authBase = 'https://auth.calendly.com'

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly calendlyRepository: CalendlyRepository,
  ) {}

  async getOAuthUrl(userId: string): Promise<string> {
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')

    const { error } = await this.calendlyRepository.insertOAuthState({
      state,
      user_id: userId,
      code_verifier: codeVerifier,
    })

    if (error) {
      this.logger.error(
        `Failed to store Calendly OAuth state for user ${userId}: ${error.message}`,
      )
      throw new Error('Failed to store OAuth state: ' + error.message)
    }

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
    // Tiny helper so each failure path stays a one-liner, and the
    // wire shape (`?calendly=error&reason=<code>`) is impossible to
    // get wrong by hand. Reason codes match
    // `OAuthFailureReason` from `stripe/connection/oauth.ts`.
    const errorRedirect = (reason: string) =>
      `${this.frontendUrl}/hub/connections?calendly=error&reason=${reason}`

    const { data: stateRow } = await this.calendlyRepository.findOAuthStateByState(state)

    if (!stateRow) {
      this.logger.warn(`Calendly OAuth state not found (state=${state})`)
      return errorRedirect('state_invalid')
    }

    const userId = stateRow.user_id as string
    const codeVerifier = stateRow.code_verifier as string

    try {
      const oauthClient = new CalendlyOAuthClient(this.clientId, this.clientSecret)
      let tokens: { access_token: string; refresh_token: string; expires_in: number }
      try {
        tokens = await oauthClient.exchangeAuthorizationCode(code, codeVerifier, this.redirectUri)
      } catch (err) {
        if (err instanceof CalendlyOAuthHttpError) {
          this.logger.error('Calendly token exchange failed', {
            status: err.status,
            body: err.body.slice(0, 200),
          })
        } else {
          this.logger.error('Calendly token exchange failed', err)
        }
        return errorRedirect('token_exchange')
      }

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      let me: { uri: string; current_organization: string }
      try {
        me = await new CalendlyApiClient(tokens.access_token, 'oauth-callback').getMe()
      } catch (err) {
        this.logger.error(fmtFailure('Calendly /users/me', err, { userId }))
        return errorRedirect('account_resolve')
      }

      const { data: conn, error: connErr } = await this.connectionsRepository.insert({
        name: 'Calendly',
        type: 'calendly',
        user_id: userId,
      })

      if (connErr) {
        this.logger.error(
          `Calendly: failed to create connection row for user ${userId}: ${connErr.message}`,
        )
        return errorRedirect('credentials_save')
      }

      // Encrypt OAuth tokens with the per-user envelope before write —
      // see `common/crypto/encryption.ts` for the algorithm rationale.
      // `userId` is in scope from the OAuth state row above.
      const { error: credErr } = await this.calendlyRepository.insert({
        connection_id: conn.id,
        access_token: encryptForUser(tokens.access_token, userId),
        refresh_token: encryptForUser(tokens.refresh_token, userId),
        expires_at: expiresAt,
        user_uri: me.uri,
        organization_uri: me.current_organization,
      })

      if (credErr) {
        this.logger.error(
          `Calendly: failed to insert credentials for connection ${conn.id}: ${credErr.message}`,
        )
        // Roll back the parent row so we don't leave an orphan
        // `connections` record with no creds.
        await this.connectionsRepository.deleteById(conn.id)
        return errorRedirect('credentials_save')
      }

      this.logger.log(`Calendly connected for user ${userId}`)
      return `${this.frontendUrl}/hub/connections?calendly=connected`
    } finally {
      await this.calendlyRepository.deleteOAuthStateByState(state)
    }
  }

  async ensureFreshToken(connectionId: string): Promise<string> {
    // Pull `user_id` alongside the credentials — needed to derive the
    // per-user decryption key. See GA `ensureFreshToken` for the same
    // pattern.
    const { data, error } = await this.calendlyRepository.findWithUserJoin(connectionId)

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

    const userId = (
      Array.isArray(data.connections) ? data.connections[0] : data.connections
    )?.user_id as string | undefined
    if (!userId) {
      this.logger.error(`Calendly credentials orphaned (no user_id) for connection ${connectionId}`)
      throw new NotFoundException('Calendly credentials not found')
    }

    // Decrypt with plaintext fallback for pre-migration rows.
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

    this.logger.log(`Refreshing Calendly token for connection ${connectionId}`)

    let tokens: { access_token: string; refresh_token: string; expires_in: number }
    try {
      tokens = await new CalendlyOAuthClient(this.clientId, this.clientSecret).refreshAccessToken(
        refreshToken,
      )
    } catch (err) {
      if (err instanceof CalendlyOAuthHttpError) {
        const detail = err.body
        if (err.status >= 500) {
          this.logger.warn(
            `Calendly refresh upstream error (${err.status}) for ${connectionId}: ${detail.slice(0, 200)}`,
          )
          throw new IntegrationUpstreamException(
            'calendly',
            connectionId,
            `Calendly token endpoint returned ${err.status}`,
          )
        }
        this.logger.warn(
          `Calendly refresh failed for connection ${connectionId} (${err.status}): ${detail.slice(0, 200)}`,
        )
        throw new IntegrationReauthRequiredException('calendly', connectionId)
      }
      this.logger.warn(`Calendly refresh network error for ${connectionId}: ${String(err)}`)
      throw new IntegrationUpstreamException(
        'calendly',
        connectionId,
        'Could not reach Calendly token endpoint',
      )
    }

    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Calendly *rotates* refresh tokens on each successful refresh, so we
    // must persist the new one — unlike Google, which reuses the original.
    // Re-encrypt both with the per-user envelope. `userId` is in scope
    // from the join above.
    await this.calendlyRepository.updateTokens(connectionId, {
      access_token: encryptForUser(tokens.access_token, userId),
      refresh_token: encryptForUser(tokens.refresh_token, userId),
      expires_at: newExpiresAt,
    })

    return tokens.access_token
  }

  async getUserUri(connectionId: string): Promise<string> {
    const { data } = await this.calendlyRepository.findUserUri(connectionId)

    if (!data) throw new NotFoundException('Calendly credentials not found')
    return data.user_uri as string
  }

  async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.connectionsRepository.findIdByConnectionAndUser(
      connectionId,
      userId,
    )

    // 410 (not 404) so the per-view live-value tile renders the inline
    // reattach prompt. Mirrors the GA `verifyOwnership` change.
    if (!data) throw new ConnectionMissingException('calendly', connectionId)
  }
}
