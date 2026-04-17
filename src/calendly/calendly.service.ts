import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
import { SupabaseService } from '../supabase/supabase.service'
import { ViewsService } from '../views/views.service'

export interface CalendlyMeeting {
  startTime: string
  endTime: string
  name: string
  bookingUri: string
  invitees: { name: string; email: string }[]
  description: string | null
}

@Injectable()
export class CalendlyService {
  private readonly logger = new Logger(CalendlyService.name)

  private readonly clientId = process.env.CALENDLY_CLIENT_ID!
  private readonly clientSecret = process.env.CALENDLY_CLIENT_SECRET!
  private readonly redirectUri = `${process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3001'}/calendly/oauth/callback`
  private readonly frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
  private readonly baseApi = 'https://api.calendly.com'
  private readonly authBase = 'https://auth.calendly.com'

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly viewsService: ViewsService,
  ) {}

  // ── OAuth ─────────────────────────────────────────────────────────────────

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
      // Exchange code for tokens
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

      // Get user info
      const meRes = await fetch(`${this.baseApi}/users/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })

      if (!meRes.ok) throw new Error('Failed to fetch Calendly user info')
      const me = (await meRes.json()) as {
        resource: { uri: string; current_organization: string }
      }

      // Create base connection record
      const { data: conn, error: connErr } = await client
        .from('connections')
        .insert({ name: 'Calendly', type: 'calendly', user_id: userId })
        .select()
        .single()

      if (connErr) throw new Error('Failed to create connection: ' + connErr.message)

      // Store credentials
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
      // Always clean up state row
      await client.from('calendly_oauth_state').delete().eq('state', state)
    }
  }

  // ── Token management ──────────────────────────────────────────────────────

  private async ensureFreshToken(connectionId: string): Promise<string> {
    const client = this.supabaseService.getClient()

    const { data } = await client
      .from('connections_calendly')
      .select('access_token, refresh_token, expires_at')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Calendly credentials not found')

    const expiresAt = new Date(data.expires_at as string)
    const bufferTime = new Date(Date.now() + 5 * 60 * 1000)

    if (expiresAt > bufferTime) {
      return data.access_token as string
    }

    this.logger.log(`Refreshing Calendly token for connection ${connectionId}`)

    const tokenRes = await fetch(`${this.authBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token as string,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })

    if (!tokenRes.ok) throw new UnauthorizedException('Failed to refresh Calendly token')

    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

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

  // ── Data fetching ─────────────────────────────────────────────────────────

  async fetchLiveValue(connectionId: string, viewType: string, userId: string): Promise<string> {
    await this.verifyOwnership(connectionId, userId)
    const token = await this.ensureFreshToken(connectionId)
    const userUri = await this.getUserUri(connectionId)

    const events = await this.getTodayEvents(token, userUri)
    const count = String(events.length)

    await this.viewsService.upsertValue(connectionId, viewType, count)
    this.logger.log(`calendly_meetings_today → ${count}`)
    return count
  }

  async fetchMeetingsList(connectionId: string, userId: string): Promise<CalendlyMeeting[]> {
    await this.verifyOwnership(connectionId, userId)
    const token = await this.ensureFreshToken(connectionId)
    const userUri = await this.getUserUri(connectionId)

    const events = await this.getTodayEvents(token, userUri)
    const meetings: CalendlyMeeting[] = []

    for (const event of events) {
      const uri = event.uri as string
      const uuid = uri.split('/').pop()!

      let invitees: { name: string; email: string }[] = []
      try {
        const inviteesRes = await fetch(`${this.baseApi}/scheduled_events/${uuid}/invitees`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (inviteesRes.ok) {
          const inviteesData = (await inviteesRes.json()) as {
            collection: { name: string; email: string }[]
          }
          invitees = inviteesData.collection.map(inv => ({
            name: inv.name,
            email: inv.email,
          }))
        }
      } catch {
        this.logger.warn(`Failed to fetch invitees for event ${uuid}`)
      }

      meetings.push({
        startTime: event.start_time as string,
        endTime: event.end_time as string,
        name: event.name as string,
        bookingUri: uri,
        invitees,
        description: (event.description ?? null) as string | null,
      })
    }

    return meetings
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async verifyOwnership(connectionId: string, userId: string): Promise<void> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Connection not found')
  }

  private async getUserUri(connectionId: string): Promise<string> {
    const { data } = await this.supabaseService
      .getClient()
      .from('connections_calendly')
      .select('user_uri')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Calendly credentials not found')
    return data.user_uri as string
  }

  private async getTodayEvents(token: string, userUri: string): Promise<Record<string, unknown>[]> {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setUTCHours(0, 0, 0, 0)
    const todayEnd = new Date(now)
    todayEnd.setUTCHours(23, 59, 59, 999)

    const url = new URL(`${this.baseApi}/scheduled_events`)
    url.searchParams.set('user', userUri)
    url.searchParams.set('min_start_time', todayStart.toISOString())
    url.searchParams.set('max_start_time', todayEnd.toISOString())
    url.searchParams.set('status', 'active')
    url.searchParams.set('count', '100')

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error('Calendly API error: ' + JSON.stringify(body))
    }

    const data = (await res.json()) as { collection: Record<string, unknown>[] }
    return data.collection
  }

}
