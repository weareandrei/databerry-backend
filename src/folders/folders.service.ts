import { Injectable, NotFoundException } from '@nestjs/common'
import { FoldersRepository } from './folders.repository'

export interface CreateFolderDto {
  name: string
  parentId: string | null
  projectId: string
}

export interface UpdateFolderDto {
  name?: string
  color?: string
}

@Injectable()
export class FoldersService {
  constructor(private readonly foldersRepository: FoldersRepository) {}

  async getFolders(userId: string) {
    const { data, error } = await this.foldersRepository.findByUserId(userId)
    if (error) throw new Error(error.message)
    return data.map(this.toCamel)
  }

  async getFolderById(folderId: string, userId: string) {
    const { data, error } = await this.foldersRepository.findById(folderId, userId)
    if (error || !data) throw new NotFoundException('Folder not found')
    return this.toCamel(data)
  }

  async createFolder(dto: CreateFolderDto, userId: string) {
    const { data, error } = await this.foldersRepository.insert({
      name: dto.name,
      parent_id: dto.parentId ?? null,
      project_id: dto.projectId,
      user_id: userId,
    })
    if (error) throw new Error(error.message)
    return this.toCamel(data)
  }

  async updateFolder(folderId: string, dto: UpdateFolderDto, userId: string) {
    const { data, error } = await this.foldersRepository.update(folderId, userId, {
      name: dto.name,
      color: dto.color,
      updated_at: new Date().toISOString(),
    })
    if (error || !data) throw new NotFoundException('Folder not found')
    return this.toCamel(data)
  }

  async deleteFolder(folderId: string, userId: string) {
    const { error } = await this.foldersRepository.delete(folderId, userId)
    if (error) throw new Error(error.message)
  }

  private toCamel(row: Record<string, unknown>) {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? null,
      projectId: row.project_id,
      userId: row.user_id,
      color: row.color ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
