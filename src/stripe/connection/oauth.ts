import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { StripeBackfillService } from '../sync/backfill.service'
import { makeStripeGetter } from '../views/stripe-api.helpers'
import { encryptForUser } from '../../common/crypto/encryption'

/**
 * Reason codes shared with the frontend `useOAuthCallback` hook —
 * see `frontend/hooks/useOAuthCallback.ts`'s REASONS map. The
 * controller catches an `OAuthCallbackError` and forwards the code
 * via `?stripe=error&reason=<code>` so the frontend can show a
 * tailored message. Same enum used for Calendly / Google Analytics
 * to keep the message map per-provider but the wire codes uniform.
 */
export type OAuthFailureReason =
  | 'cancelled'
  | 'state_invalid'
  | 'token_exchange'
  | 'client_mode_mismatch'
  | 'account_resolve'
  | 'credentials_save'
  | 'unknown'

export class OAuthCallbackError extends Error {
  constructor(
    public readonly reason: OAuthFailureReason,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthCallbackError'
  }
}

@Injectable()
export class StripeOAuthService {
  private readonly logger = new Logger(StripeOAuthService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly backfillService: StripeBackfillService,
  ) {}

  getOAuthUrl(userId: string): string {
    const clientId = process.env.STRIPE_CLIENT_ID
    if (!clientId) throw new InternalServerErrorException('STRIPE_CLIENT_ID not set')

    const backendUrl =
      process.env.WEBHOOK_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3008}`
    const redirectUri = `${backendUrl}/stripe/oauth/callback`
    const state = Buffer.from(userId).toString('base64')

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'read_write',
      redirect_uri: redirectUri,
      state,
    })

    this.logger.log(`\n  ► getOAuthUrl\n  userId      : ${userId}\n  redirectUri : ${redirectUri}`)
    return `https://connect.stripe.com/oauth/authorize?${params.toString()}`
  }

  async handleOAuthCallback(code: string, state: string): Promise<{ connectionId: string }> {
    let userId: string
    try {
      userId = Buffer.from(state, 'base64').toString('utf8')
    } catch {
      this.logger.warn(`Stripe OAuth state decode failed (state=${state})`)
      throw new OAuthCallbackError('state_invalid', 'Invalid state parameter')
    }

    this.logger.log(`\n  ► handleOAuthCallback\n  userId : ${userId}`)

    const secretKey = process.env.STRIPE_SECRET_KEY
    if (!secretKey) throw new InternalServerErrorException('STRIPE_SECRET_KEY not set')

    const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_secret: secretKey,
        code,
        grant_type: 'authorization_code',
      }),
    })

    const tokenData = (await tokenRes.json()) as Record<string, unknown>

    if (!tokenRes.ok || tokenData.error) {
      // Detect the canonical "your client_id and secret are in different
      // modes" failure. Stripe returns `invalid_grant` with exactly this
      // message when the `client_id` used during /authorize was issued
      // for a different mode (test vs live) than the secret key used
      // here. The Stripe Connect dashboard shows TWO `client_id`s side
      // by side — one per mode — and it's surprisingly easy to grab the
      // wrong one. The cross-mode failure looks identical to a "real"
      // OAuth issue in the upstream response, so without this
      // detection the user has no way to know what's wrong.
      const errorDescription = String(tokenData.error_description ?? '')
      const isClientModeMismatch =
        tokenData.error === 'invalid_grant' &&
        /authorization code provided does not belong to you/i.test(errorDescription)

      if (isClientModeMismatch) {
        const clientId = process.env.STRIPE_CLIENT_ID ?? ''
        const secretPrefix = secretKey.slice(0, 8)
        this.logger.error(
          `  ✗ Stripe OAuth: STRIPE_CLIENT_ID and STRIPE_SECRET_KEY appear to be in different modes\n` +
            `  client_id=${clientId}  secret_prefix=${secretPrefix}…\n` +
            `  → check the Connect settings page in Stripe — there's one client_id per mode (test/live), ` +
            `the secret key MUST match the mode of the client_id`,
        )
        throw new OAuthCallbackError(
          'client_mode_mismatch',
          'STRIPE_CLIENT_ID and STRIPE_SECRET_KEY are in different modes (test vs live)',
        )
      }

      this.logger.error(`  ✗ Stripe OAuth token exchange failed\n  ${JSON.stringify(tokenData)}`)
      throw new OAuthCallbackError('token_exchange', 'Stripe OAuth token exchange failed')
    }

    const stripeAccountId = tokenData.stripe_user_id as string
    const accessToken = tokenData.access_token as string
    const refreshToken = tokenData.refresh_token as string | undefined
    const scope = tokenData.scope as string | undefined

    this.logger.log(`  → stripe_account_id : ${stripeAccountId}`)

    const client = this.supabaseService.getClient()

    // Discover account metadata BEFORE writing anything. The connections_stripe
    // row FKs into `stripe_accounts.id`, so the parent row must exist before
    // we insert credentials. Doing the /v1/account call up-front also lets a
    // bad token fail cleanly before we've written half a connection.
    //
    // We use the just-received access token (which is account-scoped) rather
    // than the platform key so /v1/account returns the connected account's
    // row, not the platform's.
    let accountRow: Awaited<ReturnType<StripeBackfillService['resolveAccountFromCredentials']>>
    try {
      accountRow = await this.backfillService.resolveAccountFromCredentials(
        makeStripeGetter(accessToken),
        accessToken,
      )
    } catch (err) {
      this.logger.error(
        `  ✗ /v1/account failed for ${stripeAccountId}: ${String(err)} — aborting OAuth flow`,
      )
      throw new OAuthCallbackError(
        'account_resolve',
        'Failed to resolve Stripe account',
      )
    }

    await this.backfillService.upsertAccountRow(accountRow)

    const { data: connection, error: connError } = await client
      .from('connections')
      .insert({ name: 'Stripe', type: 'stripe', user_id: userId })
      .select()
      .single()

    if (connError) {
      this.logger.error(`  ✗ Failed to insert connection\n  ${connError.message}`)
      throw new OAuthCallbackError('credentials_save', connError.message)
    }

    // Encrypt OAuth tokens with the per-user envelope before write —
    // see `common/crypto/encryption.ts` for the algorithm rationale.
    // `userId` is decoded from the OAuth state at the top of this method.
    const { error: stripeError } = await client.from('connections_stripe').insert({
      connection_id: connection.id,
      stripe_account_id: stripeAccountId,
      access_token: encryptForUser(accessToken, userId),
      refresh_token: refreshToken ? encryptForUser(refreshToken, userId) : null,
      scope: scope ?? null,
    })

    if (stripeError) {
      await client.from('connections').delete().eq('id', connection.id)
      this.logger.error(`  ✗ Failed to insert connections_stripe\n  ${stripeError.message}`)
      throw new OAuthCallbackError('credentials_save', stripeError.message)
    }

    // Credentials are now in place — safe to kick the fire-and-forget backfill.
    // For first-time accounts this runs the full 90-day backfill; for
    // accounts already linked via another connection (same `stripe_account_id`)
    // it gap-fills from `last_synced_at` to now so the user immediately
    // sees anything that's happened since the last sync.
    this.backfillService.kickBackfillOnConnect(accountRow.id)

    this.logger.log(`  ✓ Stripe connection created\n  connection_id : ${connection.id}`)
    return { connectionId: connection.id }
  }
}
