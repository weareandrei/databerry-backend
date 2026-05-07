import {
  BadGatewayException,
  Controller,
  Get,
  Logger,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'

const VERCEL_API = 'https://api.vercel.com'

@UseGuards(SupabaseAuthGuard)
@Controller('vercel/connection')
export class VercelConnectionController {
  private readonly logger = new Logger(VercelConnectionController.name)

  @Get('projects')
  async getProjects(@Query('token') token: string) {
    const res = await fetch(`${VERCEL_API}/v9/projects?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      // Log the raw upstream payload server-side; surface a clean
      // status to the client so we don't leak Vercel's response shape.
      this.logger.warn(`Vercel API ${res.status}: ${JSON.stringify(body)}`)
      // 401 / 403 means the user-supplied token is bad — distinct
      // from a generic upstream failure (5xx/network) so the connect
      // form can show "check your token" rather than a generic retry.
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(
          "Vercel didn't accept this token. Make sure it's a Personal Access Token from " +
            'vercel.com/account/tokens (Team or Project tokens won\'t work for ' +
            'listing your projects).',
        )
      }
      throw new BadGatewayException(
        "Couldn't reach Vercel. Try again in a moment.",
      )
    }

    const data = (await res.json()) as {
      projects: { id: string; name: string }[]
    }

    return {
      projects: data.projects.map(p => ({ id: p.id, name: p.name })),
    }
  }
}
