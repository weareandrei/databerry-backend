import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { ViewsService } from '../views/views.service'

export interface CreateProjectDto {
  name: string
}

export interface UpdateProjectDto {
  name?: string
  color?: string
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly viewsService: ViewsService,
  ) {}

  async getProjects(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data.map(this.toCamel)
  }

  async createProject(dto: CreateProjectDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .insert({ name: dto.name, user_id: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)
    const project = this.toCamel(data)

    // Best-effort: auto-create the composite "Overview" views at the project root.
    // The overview is split into two independently-managed views: the chart and the
    // sources panel. Both are created together, but can be removed independently.
    try {
      await this.viewsService.createView(
        {
          projectId: project.id as string,
          folderId: undefined,
          connectionId: null,
          connectionType: 'composite',
          type: 'project_overview',
          name: 'Overview',
          config: { primaryMetric: 'visitors', secondaryMetric: null },
        },
        userId,
      )
    } catch (err) {
      this.logger.warn(`Failed to auto-create overview chart view for project ${project.id}: ${String(err)}`)
    }
    try {
      await this.viewsService.createView(
        {
          projectId: project.id as string,
          folderId: undefined,
          connectionId: null,
          connectionType: 'composite',
          type: 'project_overview_sources',
          name: 'Sources',
          config: { sourcesLimit: 10 },
        },
        userId,
      )
    } catch (err) {
      this.logger.warn(`Failed to auto-create overview sources view for project ${project.id}: ${String(err)}`)
    }

    return project
  }

  async updateProject(projectId: string, dto: UpdateProjectDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .update({ name: dto.name, color: dto.color, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw new NotFoundException('Project not found')
    return this.toCamel(data)
  }

  async deleteProject(projectId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId)

    if (error) throw new Error(error.message)
  }

  private toCamel(row: Record<string, unknown>) {
    return {
      id: row.id,
      name: row.name,
      userId: row.user_id,
      color: row.color ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
