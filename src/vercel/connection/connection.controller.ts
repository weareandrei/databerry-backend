import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import { VercelApiClient } from '../vercel-api.client'

@UseGuards(SupabaseAuthGuard)
@Controller('vercel/connection')
export class VercelConnectionController {
  @Get('projects')
  async getProjects(@Query('token') token: string) {
    const client = new VercelApiClient(token)
    const projects = await client.listProjects()
    return { projects }
  }
}
