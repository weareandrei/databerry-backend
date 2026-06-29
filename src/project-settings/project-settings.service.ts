import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { ProjectsRepository } from '../projects/projects.repository'
import { ProjectSettingsRepository } from './project-settings.repository'

export interface UpdateProjectSettingsDto {
  conversionConnectionId?: string | null
  conversionEvent?: string | null
}

export interface ProjectSettings {
  projectId: string
  conversionConnectionId: string | null
  conversionEvent: string | null
}

@Injectable()
export class ProjectSettingsService {
  private readonly logger = new Logger(ProjectSettingsService.name)

  constructor(
    private readonly projectSettingsRepository: ProjectSettingsRepository,
    private readonly projectsRepository: ProjectsRepository,
  ) {}

  async get(projectId: string, userId: string): Promise<ProjectSettings> {
    await this.assertProjectOwner(projectId, userId)

    const { data, error } = await this.projectSettingsRepository.findByProjectId(projectId)
    if (error) throw new Error(error.message)

    if (!data) {
      return {
        projectId,
        conversionConnectionId: null,
        conversionEvent: null,
      }
    }

    return this.toCamel(data)
  }

  async update(
    projectId: string,
    userId: string,
    dto: UpdateProjectSettingsDto,
  ): Promise<ProjectSettings> {
    await this.assertProjectOwner(projectId, userId)

    const patch: Record<string, unknown> = {
      project_id: projectId,
      updated_at: new Date().toISOString(),
    }
    if (dto.conversionConnectionId !== undefined)
      patch.conversion_connection_id = dto.conversionConnectionId
    if (dto.conversionEvent !== undefined) patch.conversion_event = dto.conversionEvent

    const { data, error } = await this.projectSettingsRepository.upsert(patch)
    if (error) throw new Error(error.message)
    this.logger.log(`  ✓ project_settings upserted for ${projectId}`)
    return this.toCamel(data)
  }

  private async assertProjectOwner(projectId: string, userId: string) {
    const { data, error } = await this.projectsRepository.findOwnerId(projectId)
    if (error) throw new Error(error.message)
    if (!data || data.user_id !== userId) {
      throw new ForbiddenException('Project not found')
    }
  }

  private toCamel(row: Record<string, unknown>): ProjectSettings {
    return {
      projectId: row.project_id as string,
      conversionConnectionId: (row.conversion_connection_id as string | null) ?? null,
      conversionEvent: (row.conversion_event as string | null) ?? null,
    }
  }
}
