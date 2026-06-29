const BASE_API = 'https://sentry.io/api/0'

export interface SentryTokenResponse {
  token: string
  refreshToken: string
  expires_at?: string
  expiresAt?: string
}

export class SentryOAuthHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Sentry OAuth ${operation} failed (${status})`)
    this.name = 'SentryOAuthHttpError'
  }
}

/**
 * Stateless OAuth HTTP client for Sentry Public Integrations. One
 * instance per app credential pair — never a Nest singleton.
 */
export class SentryOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async exchangeAuthorizationCode(
    installationId: string,
    code: string,
  ): Promise<SentryTokenResponse> {
    const res = await fetch(
      `${BASE_API}/sentry-app-installations/${installationId}/authorizations/`,
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
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new SentryOAuthHttpError('token exchange', res.status, body)
    }
    return (await res.json()) as SentryTokenResponse
  }

  async refreshAccessToken(
    installationId: string,
    refreshToken: string,
  ): Promise<SentryTokenResponse> {
    const res = await fetch(
      `${BASE_API}/sentry-app-installations/${installationId}/authorizations/`,
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
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new SentryOAuthHttpError('token refresh', res.status, body)
    }
    return (await res.json()) as SentryTokenResponse
  }

  async getInstallation(
    installationId: string,
    token: string,
  ): Promise<{ organization?: { slug: string } }> {
    const res = await fetch(`${BASE_API}/sentry-app-installations/${installationId}/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new SentryOAuthHttpError('install lookup', res.status, body)
    }
    return (await res.json()) as { organization?: { slug: string } }
  }
}
