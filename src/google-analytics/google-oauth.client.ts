const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/**
 * Stateless OAuth HTTP client for Google. One instance per app credential
 * pair — never a Nest singleton.
 */
export class GoogleOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
  ): Promise<GoogleTokenResponse> {
    const res = await fetch(TOKEN_URL, {
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
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GoogleOAuthHttpError('token exchange', res.status, body)
    }
    return (await res.json()) as GoogleTokenResponse
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const res = await fetch(TOKEN_URL, {
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
      throw new GoogleOAuthHttpError('token refresh', res.status, body)
    }
    return (await res.json()) as GoogleTokenResponse
  }
}

export class GoogleOAuthHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Google OAuth ${operation} failed (${status})`)
    this.name = 'GoogleOAuthHttpError'
  }
}
