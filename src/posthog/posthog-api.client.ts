export interface PosthogClientCredentials {
  apiKey: string
  projectId: string
  host: string
}

export interface HogqlQueryResult {
  results?: unknown[][]
}

export interface PosthogEventDefinitionRow {
  id: string
  name: string
  volume_30_day: number | null
  last_seen_at: string | null
}

export interface PosthogEventRow {
  event: string
  properties: Record<string, unknown>
}

export interface PosthogPersonRow {
  id: string | number
  distinct_ids?: string[]
  properties?: Record<string, unknown>
  created_at?: string
}

export interface PosthogPaginatedResult<T> {
  results?: T[]
  next?: string | null
}

export class PosthogApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body)
    super(`PostHog API error ${status}: ${detail}`)
    this.name = 'PosthogApiError'
  }
}

export class PosthogApiClient {
  constructor(private readonly credentials: PosthogClientCredentials) {}

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.credentials.apiKey}`, ...extra }
  }

  private projectBaseUrl(): string {
    return `${this.credentials.host.replace(/\/$/, '')}/api/projects/${this.credentials.projectId}`
  }

  projectUrl(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`
    return `${this.projectBaseUrl()}${normalized}`
  }

  private async requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let body: unknown = text
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      throw new PosthogApiError(res.status, body)
    }

    return res.json() as Promise<T>
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(this.projectUrl(path))
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(this.projectUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async patchJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(this.projectUrl(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async queryHogql(hogql: string): Promise<HogqlQueryResult> {
    return this.postJson<HogqlQueryResult>('/query/', {
      query: { kind: 'HogQLQuery', query: hogql },
    })
  }

  async getEventDefinitions(limit = 200): Promise<PosthogPaginatedResult<PosthogEventDefinitionRow>> {
    return this.getJson(`/event_definitions/?limit=${limit}`)
  }

  async getEvents(params: {
    limit?: number
    after?: string
  }): Promise<PosthogPaginatedResult<PosthogEventRow>> {
    const limit = params.limit ?? 1000
    const after = params.after ? `&after=${encodeURIComponent(params.after)}` : ''
    return this.getJson(`/events/?limit=${limit}${after}`)
  }

  async getPersonsPage(
    nextUrl?: string | null,
    limit = 100,
  ): Promise<PosthogPaginatedResult<PosthogPersonRow>> {
    const url = nextUrl ?? this.projectUrl(`/persons/?limit=${limit}`)
    return this.requestJson<PosthogPaginatedResult<PosthogPersonRow>>(url)
  }

  async createHogFunction(payload: unknown): Promise<{ id: string }> {
    return this.postJson('/hog_functions/', payload)
  }

  async deleteHogFunction(hogFunctionId: string): Promise<void> {
    await this.patchJson(`/hog_functions/${hogFunctionId}/`, { deleted: true })
  }
}
