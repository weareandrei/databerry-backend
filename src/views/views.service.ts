import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { PosthogService } from '../posthog/posthog.service'

export interface CreateViewDto {
  projectId: string
  folderId?: string
  connectionId: string
  connectionType: string
  type: string
  name: string
  config?: Record<string, unknown>
}

@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly posthogService: PosthogService,
  ) {}

  async getViewsByFolder(folderId: string, userId: string, dateFrom?: string, dateTo?: string) {
    this.logger.log(
      `\n  ► getViewsByFolder\n  folderId : ${folderId}\n  userId   : ${userId}\n  dateFrom : ${dateFrom ?? 'none'}\n  dateTo   : ${dateTo ?? 'none'}`,
    )

    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .select('*, views_values(value, created_at)')
      .eq('folder_id', folderId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data.map(row => this.toCamel(row, dateFrom, dateTo))
  }

  async getViewsByProject(projectId: string, userId: string, dateFrom?: string, dateTo?: string) {
    this.logger.log(
      `\n  ► getViewsByProject\n  projectId : ${projectId}\n  userId    : ${userId}\n  dateFrom  : ${dateFrom ?? 'none'}\n  dateTo    : ${dateTo ?? 'none'}`,
    )

    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .select('*, views_values(value, created_at)')
      .eq('project_id', projectId)
      .is('folder_id', null)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data.map(row => this.toCamel(row, dateFrom, dateTo))
  }

  async getPinnedViews(userId: string) {
    this.logger.log(`\n  ► getPinnedViews\n  userId : ${userId}`)

    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .select('*, views_values(value, created_at)')
      .eq('user_id', userId)
      .eq('is_pinned', true)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data.map(row => this.toCamel(row))
  }

  async pinView(viewId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('views')
      .update({ is_pinned: true })
      .eq('id', viewId)
      .eq('user_id', userId)

    if (error) throw new Error(error.message)
  }

  async unpinView(viewId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('views')
      .update({ is_pinned: false })
      .eq('id', viewId)
      .eq('user_id', userId)

    if (error) throw new Error(error.message)
  }

  async createView(dto: CreateViewDto, userId: string) {
    this.logger.log(
      `\n  ► createView\n  projectId      : ${dto.projectId}\n  folderId       : ${dto.folderId ?? 'none (project root)'}\n  connectionId   : ${dto.connectionId}\n  connectionType : ${dto.connectionType}\n  name           : ${dto.name}`,
    )

    const baseInsert = {
      project_id: dto.projectId,
      folder_id: dto.folderId ?? null,
      connection_id: dto.connectionId,
      connection_type: dto.connectionType,
      type: dto.type,
      name: dto.name,
      config: dto.config ?? {},
      is_pinned: false,
      user_id: userId,
    }

    // For PostHog views: create Hog Function first — if it fails, abort
    if (dto.connectionType === 'posthog') {
      const eventName = (dto.config?.eventName as string) ?? dto.name

      const { data: tempView, error: tempError } = await this.supabaseService
        .getClient()
        .from('views')
        .insert(baseInsert)
        .select()
        .single()

      if (tempError) {
        this.logger.error(`  ✗ createView failed\n  ${tempError.message}`)
        throw new Error(tempError.message)
      }

      const hogFunctionId = await this.posthogService.createHogFunction(
        dto.connectionId,
        tempView.id as string,
        eventName,
      )

      if (!hogFunctionId) {
        await this.supabaseService.getClient().from('views').delete().eq('id', tempView.id)
        this.logger.error(`  ✗ Hog Function creation failed — view rolled back`)
        throw new Error(
          'Failed to register PostHog destination. Check your API key has the hog_function:write scope.',
        )
      }

      await this.supabaseService
        .getClient()
        .from('views')
        .update({ config: { ...(dto.config ?? {}), hogFunctionId } })
        .eq('id', tempView.id)

      this.logger.log(`  ✓ view created and hog function registered  id: ${tempView.id}`)
      return this.toCamel({ ...tempView, config: { ...(dto.config ?? {}), hogFunctionId } })
    }

    // Non-PostHog views — create directly
    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .insert(baseInsert)
      .select()
      .single()

    if (error) {
      this.logger.error(`  ✗ createView failed\n  ${error.message}`)
      throw new Error(error.message)
    }

    this.logger.log(`  ✓ view created  id: ${data.id}`)
    return this.toCamel(data)
  }

  async deleteView(viewId: string, userId: string) {
    this.logger.log(`\n  ► deleteView\n  viewId : ${viewId}\n  userId : ${userId}`)

    const { data: view } = await this.supabaseService
      .getClient()
      .from('views')
      .select('connection_id, connection_type, config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()

    const { error } = await this.supabaseService
      .getClient()
      .from('views')
      .delete()
      .eq('id', viewId)
      .eq('user_id', userId)

    if (error) {
      this.logger.error(`  ✗ deleteView failed\n  ${error.message}`)
      throw new NotFoundException('View not found')
    }

    this.logger.log(`  ✓ view deleted`)

    if (
      view?.connection_type === 'posthog' &&
      view?.connection_id &&
      (view.config as Record<string, unknown>)?.hogFunctionId
    ) {
      const hogFunctionId = (view.config as Record<string, unknown>).hogFunctionId as string
      this.posthogService
        .deleteHogFunction(view.connection_id as string, hogFunctionId)
        .catch(err => {
          this.logger.error(`  ✗ deleteHogFunction failed silently\n  ${err.message}`)
        })
    }
  }

  private aggregateValues(
    values: { value: string; created_at: string }[],
    viewType: string,
    dateFrom?: string,
    dateTo?: string,
  ): string | null {
    // Filter to the requested date range.
    // created_at may be a full ISO timestamp — slice to the date part for comparison.
    let filtered = values
    if (dateFrom) filtered = filtered.filter(v => v.created_at.slice(0, 10) >= dateFrom)
    if (dateTo)   filtered = filtered.filter(v => v.created_at.slice(0, 10) <= dateTo)

    // Special case: webhook_append (PostHog) — count records in range; 0 when none
    if (viewType === 'webhook_append') {
      return String(filtered.length)
    }

    if (filtered.length === 0) return '0'

    // Gauge types → return the latest value in range (no sum)
    const isGauge = viewType.includes('gauge') || viewType.includes('mrr')
    if (isGauge) {
      const sorted = [...filtered].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      return sorted[0].value
    }

    // Counter / revenue / everything else → SUM
    const total = filtered.reduce((acc, v) => acc + (parseFloat(v.value) || 0), 0)
    return String(total)
  }

  private toCamel(row: Record<string, unknown>, dateFrom?: string, dateTo?: string) {
    const values = (row.views_values as { value: string; created_at: string }[] | null) ?? []
    const viewType = (row.type as string) ?? 'daily_counter'

    const displayValue = this.aggregateValues(values, viewType, dateFrom, dateTo)

    return {
      id: row.id,
      projectId: row.project_id,
      folderId: row.folder_id ?? null,
      connectionId: row.connection_id,
      connectionType: row.connection_type,
      type: viewType,
      name: row.name,
      config: row.config ?? {},
      value: displayValue,
      isPinned: row.is_pinned ?? false,
      userId: row.user_id,
      createdAt: row.created_at,
    }
  }
}
