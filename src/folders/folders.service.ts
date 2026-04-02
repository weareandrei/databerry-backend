import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface CreateFolderDto {
  name: string;
  parentId: string | null;
}

export interface UpdateFolderDto {
  name?: string;
  color?: string;
}

@Injectable()
export class FoldersService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async getFolders(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('folders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return data.map(this.toCamel);
  }

  async getFolderById(folderId: string, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('folders')
      .select('*')
      .eq('id', folderId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Folder not found');
    return this.toCamel(data);
  }

  async createFolder(dto: CreateFolderDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('folders')
      .insert({
        name: dto.name,
        parent_id: dto.parentId ?? null,
        user_id: userId,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return this.toCamel(data);
  }

  async updateFolder(folderId: string, dto: UpdateFolderDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('folders')
      .update({ name: dto.name, color: dto.color, updated_at: new Date().toISOString() })
      .eq('id', folderId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Folder not found');
    return this.toCamel(data);
  }

  async deleteFolder(folderId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('folders')
      .delete()
      .eq('id', folderId)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);
  }

  private toCamel(row: Record<string, unknown>) {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? null,
      userId: row.user_id,
      color: row.color ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
