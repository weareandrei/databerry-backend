import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class FoldersRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByUserId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('folders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
  }

  async findById(folderId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('folders')
      .select('*')
      .eq('id', folderId)
      .eq('user_id', userId)
      .single()
  }

  async insert(row: {
    name: string
    parent_id: string | null
    project_id: string
    user_id: string
  }) {
    return this.supabaseService
      .getClient()
      .from('folders')
      .insert(row)
      .select()
      .single()
  }

  async update(
    folderId: string,
    userId: string,
    patch: { name?: string; color?: string; updated_at: string },
  ) {
    return this.supabaseService
      .getClient()
      .from('folders')
      .update(patch)
      .eq('id', folderId)
      .eq('user_id', userId)
      .select()
      .single()
  }

  async delete(folderId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('folders')
      .delete()
      .eq('id', folderId)
      .eq('user_id', userId)
  }
}
