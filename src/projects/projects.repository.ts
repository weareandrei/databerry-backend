import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class ProjectsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
  }

  async insert(row: {
    name: string
    user_id: string
    website_url: string | null
  }) {
    return this.supabaseService
      .getClient()
      .from('projects')
      .insert(row)
      .select()
      .single()
  }

  async update(projectId: string, userId: string, patch: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('projects')
      .update(patch)
      .eq('id', projectId)
      .eq('user_id', userId)
      .select()
      .single()
  }

  async delete(projectId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId)
  }

  async findOwnerId(projectId: string) {
    return this.supabaseService
      .getClient()
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle()
  }
}
