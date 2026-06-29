const AUTH_BASE = 'https://auth.calendly.com'

export interface CalendlyTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

export class CalendlyOAuthHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Calendly OAuth ${operation} failed (${status})`)
    this.name = 'CalendlyOAuthHttpError'
  }
}

/**
 * Stateless OAuth HTTP client for Calendly. One instance per app
 * credential pair — never a Nest singleton.
 */
export class CalendlyOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<CalendlyTokenResponse> {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code_verifier: codeVerifier,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new CalendlyOAuthHttpError('token exchange', res.status, body)
    }
    return (await res.json()) as CalendlyTokenResponse
  }

  async refreshAccessToken(refreshToken: string): Promise<CalendlyTokenResponse> {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new CalendlyOAuthHttpError('token refresh', res.status, body)
    }
    return (await res.json()) as CalendlyTokenResponse
  }
}
