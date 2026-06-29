import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class ProjectSettingsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByProjectId(projectId: string) {
    return this.supabaseService
      .getClient()
      .from('project_settings')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle()
  }

  async upsert(patch: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('project_settings')
      .upsert(patch, { onConflict: 'project_id' })
      .select()
      .single()
  }
}
