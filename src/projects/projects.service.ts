import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { ViewsService } from '../views/views.service'

export interface CreateProjectDto {
  name: string
  /**
   * Optional website URL. When set, the dashboard renders the site's
   * favicon next to the project name (via Google's `s2/favicons`
   * resolver — no storage on our side). NULL / undefined ⇒ generic
   * Cube icon.
   *
   * The frontend pre-prepends `https://` if missing before submitting,
   * so what arrives here is always a valid URL string. We don't
   * normalize further — preserves the user's original entry (path /
   * query) for round-trip on the edit form.
   */
  websiteUrl?: string | null
}

export interface UpdateProjectDto {
  name?: string
  color?: string
  /** Same semantics as `CreateProjectDto.websiteUrl`. Pass `null`
   *  explicitly to clear an existing value. */
  websiteUrl?: string | null
}

/**
 * Light pre-flight normalisation. Trims whitespace, prepends `https://`
 * when no scheme is present, and validates that the result parses as a
 * URL. Returns `null` for the empty / invalid case so the caller stores
 * NULL in the DB (which renders the generic Cube icon).
 */
function normalizeWebsiteUrl(input: string | null | undefined): string | null {
  if (input == null) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    // `new URL` throws on garbage. We don't keep the parsed object —
    // just use it as a validator.
    new URL(withScheme)
    return withScheme
  } catch {
    return null
  }
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
      .insert({
        name: dto.name,
        user_id: userId,
        website_url: normalizeWebsiteUrl(dto.websiteUrl),
      })
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
    // Build the update payload selectively — only include keys the caller
    // actually sent, so a "rename" doesn't accidentally clear `color` or
    // `websiteUrl`. `null` IS a meaningful value for `websiteUrl` (clears
    // the favicon back to Cube), so we distinguish "key omitted" from
    // "key sent as null" here.
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (dto.name !== undefined) update.name = dto.name
    if (dto.color !== undefined) update.color = dto.color
    if (dto.websiteUrl !== undefined) {
      update.website_url = normalizeWebsiteUrl(dto.websiteUrl)
    }

    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .update(update)
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
      websiteUrl: (row.website_url as string | null | undefined) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
