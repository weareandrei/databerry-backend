import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'

const VERCEL_API = 'https://api.vercel.com'

@UseGuards(SupabaseAuthGuard)
@Controller('vercel/connection')
export class VercelConnectionController {
  @Get('projects')
  async getProjects(@Query('token') token: string) {
    const res = await fetch(`${VERCEL_API}/v9/projects?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`Vercel API error ${res.status}: ${JSON.stringify(body)}`)
    }

    const data = (await res.json()) as {
      projects: { id: string; name: string }[]
    }

    return {
      projects: data.projects.map(p => ({ id: p.id, name: p.name })),
    }
  }
}
