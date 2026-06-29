import { BadGatewayException, Logger, UnauthorizedException } from '@nestjs/common'

const VERCEL_API = 'https://api.vercel.com'
const vercelApiLogger = new Logger('VercelAPI')

/**
 * Authenticated HTTP client for the Vercel API. One instance per token —
 * never a singleton.
 */
export class VercelApiClient {
  constructor(private readonly token: string) {}

  /** GET /v9/projects — returns id + name for each project. */
  async listProjects(): Promise<{ id: string; name: string }[]> {
    const res = await fetch(`${VERCEL_API}/v9/projects?limit=100`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      vercelApiLogger.warn(`Vercel API ${res.status}: ${JSON.stringify(body)}`)
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(
          "Vercel didn't accept this token. Make sure it's a Personal Access Token from " +
            'vercel.com/account/tokens (Team or Project tokens won\'t work for ' +
            'listing your projects).',
        )
      }
      throw new BadGatewayException("Couldn't reach Vercel. Try again in a moment.")
    }

    const data = (await res.json()) as {
      projects: { id: string; name: string }[]
    }

    return data.projects.map(p => ({ id: p.id, name: p.name }))
  }
}
