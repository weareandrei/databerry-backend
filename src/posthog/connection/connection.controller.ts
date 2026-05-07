import {
  BadGatewayException,
  Body,
  Controller,
  Logger,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'

/**
 * One-shot project lookup used by the PostHog connection flow.
 *
 * The frontend posts the user's personal API key + region host BEFORE
 * the connection is saved. We hit `${host}/api/projects/` ourselves
 * (not the browser, so the key doesn't leak through CORS or browser
 * dev-tools network logs of arbitrary subdomains) and return a
 * trimmed list. The frontend renders that list in a picker — same UX
 * pattern as `vercel/connection/projects`.
 *
 * Why POST + body (vs. Vercel's GET + query): the personal API key
 * is sensitive enough that we'd rather not have it in URL access
 * logs. Behaviour is otherwise identical.
 */

interface ListProjectsBody {
  apiKey: string
  /** PostHog API host. Typically `https://us.posthog.com` or
   *  `https://eu.posthog.com`. Required — the frontend always picks
   *  one before submitting. */
  host: string
}

interface PosthogProjectRow {
  id: number
  name: string
  organization?: string
}

@UseGuards(SupabaseAuthGuard)
@Controller('posthog/connection')
export class PosthogConnectionController {
  private readonly logger = new Logger(PosthogConnectionController.name)

  @Post('projects')
  async listProjects(@Body() body: ListProjectsBody) {
    const apiKey = body.apiKey?.trim()
    const host = body.host?.trim().replace(/\/$/, '')
    if (!apiKey) throw new UnauthorizedException('Missing PostHog API key')
    if (!host) throw new BadGatewayException('Missing PostHog host')

    const res = await fetch(`${host}/api/projects/`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!res.ok) {
      const responseBody = await res.json().catch(() => ({}))
      // Log the upstream payload server-side; surface a clean status
      // to the client so we don't leak PostHog's response shape.
      this.logger.warn(
        `PostHog API ${res.status}: ${JSON.stringify(responseBody)}`,
      )
      // 401 / 403 → bad API key (or a key without read access on
      // Projects). Surfacing the two most common gotchas — typo in
      // the key, and region mismatch — in plain language so the
      // frontend can show this verbatim without a translation layer.
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(
          "PostHog didn't accept this API key. Two things to check: " +
            '(1) the key was copied correctly (no extra spaces), and ' +
            "(2) you picked the right region — if your PostHog account is on EU Cloud, switch the region toggle to EU.",
        )
      }
      throw new BadGatewayException(
        "Couldn't reach PostHog. Give it a moment and try again — " +
          'if it keeps failing, the region might be wrong (US vs. EU).',
      )
    }

    const data = (await res.json()) as { results?: PosthogProjectRow[] }
    const projects = (data.results ?? []).map(p => ({
      id: String(p.id),
      name: p.name,
      organization: p.organization ?? null,
    }))
    return { projects }
  }
}
