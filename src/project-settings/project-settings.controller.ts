import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { ProjectSettingsService } from './project-settings.service'
import type { UpdateProjectSettingsDto } from './project-settings.service'
import type { AuthenticatedRequest } from '../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('project-settings')
export class ProjectSettingsController {
  constructor(private readonly projectSettingsService: ProjectSettingsService) {}

  @Get(':projectId')
  async get(@Param('projectId') projectId: string, @Req() req: AuthenticatedRequest) {
    return this.projectSettingsService.get(projectId, req.authUser.id)
  }

  @Put(':projectId')
  async update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectSettingsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.projectSettingsService.update(projectId, req.authUser.id, dto)
  }
}
