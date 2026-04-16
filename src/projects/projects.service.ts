import { Injectable, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export interface CreateProjectDto {
  name: string
}

export interface UpdateProjectDto {
  name?: string
  color?: string
}

@Injectable()
export class ProjectsService {
  constructor(private readonly supabaseService: SupabaseService) {}

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
    return this.toCamel(data)
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
