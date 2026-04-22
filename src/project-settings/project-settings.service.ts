import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

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

  constructor(private readonly supabaseService: SupabaseService) {}

  async get(projectId: string, userId: string): Promise<ProjectSettings> {
    await this.assertProjectOwner(projectId, userId)

    const { data, error } = await this.supabaseService
      .getClient()
      .from('project_settings')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle()

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

    const { data, error } = await this.supabaseService
      .getClient()
      .from('project_settings')
      .upsert(patch, { onConflict: 'project_id' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    this.logger.log(`  ✓ project_settings upserted for ${projectId}`)
    return this.toCamel(data)
  }

  private async assertProjectOwner(projectId: string, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle()
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
