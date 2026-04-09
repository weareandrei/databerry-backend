import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  // ── OAuth ────────────────────────────────────────────────────────────────

  getOAuthUrl(userId: string): string {
    const clientId = process.env.STRIPE_CLIENT_ID
    if (!clientId) throw new InternalServerErrorException('STRIPE_CLIENT_ID not set')

    const backendUrl =
      process.env.WEBHOOK_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3008}`
    const redirectUri = `${backendUrl}/stripe/oauth/callback`

    // Encode userId in state so we know who to create the connection for
    const state = Buffer.from(userId).toString('base64')

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'read_write',
      redirect_uri: redirectUri,
      state,
    })

    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`

    this.logger.log(`\n  ► getOAuthUrl\n  userId      : ${userId}\n  redirectUri : ${redirectUri}`)

    return url
  }

  async handleOAuthCallback(code: string, state: string): Promise<void> {
    // Decode userId from state
    let userId: string
    try {
      userId = Buffer.from(state, 'base64').toString('utf8')
    } catch {
      throw new BadRequestException('Invalid state parameter')
    }

    this.logger.log(`\n  ► handleOAuthCallback\n  userId : ${userId}`)

    // Exchange code for access token
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
      this.logger.error(`  ✗ Stripe OAuth token exchange failed\n  ${JSON.stringify(tokenData)}`)
      throw new BadRequestException('Stripe OAuth failed')
    }

    const stripeAccountId = tokenData.stripe_user_id as string
    const accessToken = tokenData.access_token as string
    const refreshToken = tokenData.refresh_token as string | undefined
    const scope = tokenData.scope as string | undefined

    this.logger.log(`  → stripe_account_id : ${stripeAccountId}`)

    const client = this.supabaseService.getClient()

    // 1. Insert base connection
    const { data: connection, error: connError } = await client
      .from('connections')
      .insert({ name: 'Stripe', type: 'stripe', user_id: userId })
      .select()
      .single()

    if (connError) {
      this.logger.error(`  ✗ Failed to insert connection\n  ${connError.message}`)
      throw new Error(connError.message)
    }

    // 2. Insert stripe-specific record
    const { error: stripeError } = await client.from('connections_stripe').insert({
      connection_id: connection.id,
      stripe_account_id: stripeAccountId,
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
      scope: scope ?? null,
    })

    if (stripeError) {
      // Rollback connection row
      await client.from('connections').delete().eq('id', connection.id)
      this.logger.error(`  ✗ Failed to insert connections_stripe\n  ${stripeError.message}`)
      throw new Error(stripeError.message)
    }

    this.logger.log(`  ✓ Stripe connection created\n  connection_id : ${connection.id}`)
  }
}
