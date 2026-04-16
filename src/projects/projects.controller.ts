import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { ProjectsService } from './projects.service'
import type { CreateProjectDto, UpdateProjectDto } from './projects.service'

@Controller('projects')
@UseGuards(SupabaseAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  getAll(@Req() req: any) {
    return this.projectsService.getProjects(req.authUser.id)
  }

  @Post()
  create(@Body() dto: CreateProjectDto, @Req() req: any) {
    return this.projectsService.createProject(dto, req.authUser.id)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto, @Req() req: any) {
    return this.projectsService.updateProject(id, dto, req.authUser.id)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.projectsService.deleteProject(id, req.authUser.id)
  }
}
