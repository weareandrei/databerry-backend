import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

const VIEW_LIST_SELECT = '*, views_values(value, created_at)'

@Injectable()
export class ViewsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  private applyViewListOrder<T extends { order: (...args: unknown[]) => T }>(query: T): T {
    return query
      .order('position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
  }

  async findByFolderWithValues(folderId: string, userId: string) {
    return this.applyViewListOrder(
      this.supabaseService
        .getClient()
        .from('views')
        .select(VIEW_LIST_SELECT)
        .eq('folder_id', folderId)
        .eq('user_id', userId),
    )
  }

  async findByProjectWithValues(projectId: string, userId: string) {
    return this.applyViewListOrder(
      this.supabaseService
        .getClient()
        .from('views')
        .select(VIEW_LIST_SELECT)
        .eq('project_id', projectId)
        .is('folder_id', null)
        .eq('user_id', userId),
    )
  }

  async countByUser(userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
  }

  async findPinnedWithValues(userId: string) {
    return this.applyViewListOrder(
      this.supabaseService
        .getClient()
        .from('views')
        .select(VIEW_LIST_SELECT)
        .eq('user_id', userId)
        .eq('is_pinned', true),
    )
  }

  async updatePinned(viewId: string, userId: string, isPinned: boolean) {
    return this.supabaseService
      .getClient()
      .from('views')
      .update({ is_pinned: isPinned })
      .eq('id', viewId)
      .eq('user_id', userId)
  }

  async updatePosition(
    viewId: string,
    userId: string,
    projectId: string,
    folderId: string | null,
    position: number,
  ) {
    let q = this.supabaseService
      .getClient()
      .from('views')
      .update({ position })
      .eq('id', viewId)
      .eq('user_id', userId)
      .eq('project_id', projectId)
    q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId)
    return q
  }

  async findMaxPosition(userId: string, projectId: string, folderId: string | null) {
    let q = this.supabaseService
      .getClient()
      .from('views')
      .select('position')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .not('position', 'is', null)
      .order('position', { ascending: false, nullsFirst: false })
      .limit(1)
    q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId)
    return q.maybeSingle()
  }

  async insert(row: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('views')
      .insert(row)
      .select()
      .single()
  }

  async updateConfig(viewId: string, config: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('views')
      .update({ config })
      .eq('id', viewId)
  }

  async findProjectAndConnectionType(viewId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('project_id, connection_type')
      .eq('id', viewId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  async findWithValues(viewId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select(VIEW_LIST_SELECT)
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()
  }

  async update(viewId: string, userId: string, patch: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('views')
      .update(patch)
      .eq('id', viewId)
      .eq('user_id', userId)
      .select(VIEW_LIST_SELECT)
      .single()
  }

  async findConnectionAndConfig(viewId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('connection_id, connection_type, config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()
  }

  async delete(viewId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .delete()
      .eq('id', viewId)
      .eq('user_id', userId)
  }

  async findIdByConnectionAndType(connectionId: string, viewType: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('type', viewType)
      .maybeSingle()
  }

  async updateConnectionId(viewId: string, userId: string, connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .update({ connection_id: connectionId })
      .eq('id', viewId)
      .eq('user_id', userId)
  }

  async findByConnectionId(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('id, type, config')
      .eq('connection_id', connectionId)
  }

  async findTypeById(viewId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('type')
      .eq('id', viewId)
      .single()
  }

  async findConfigById(viewId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('views')
      .select('config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single()
  }

  // ── views_values ──────────────────────────────────────────────

  async insertValue(row: {
    view_id: string
    value: string
    created_at: string
    needs_sync?: boolean
  }) {
    return this.supabaseService.getClient().from('views_values').insert(row)
  }

  async updateValue(viewId: string, createdAt: string, value: string) {
    return this.supabaseService
      .getClient()
      .from('views_values')
      .update({ value, updated_at: new Date().toISOString(), needs_sync: false })
      .eq('view_id', viewId)
      .eq('created_at', createdAt)
  }

  async markValueNeedsSync(viewId: string, date: string) {
    const { error } = await this.insertValue({
      view_id: viewId,
      created_at: date,
      value: '0',
      needs_sync: true,
    })

    if (error?.code === '23505') {
      return this.supabaseService
        .getClient()
        .from('views_values')
        .update({ needs_sync: true })
        .eq('view_id', viewId)
        .eq('created_at', date)
    }

    return { data: null, error }
  }

  async findValueByViewAndDate(viewId: string, createdAt: string) {
    return this.supabaseService
      .getClient()
      .from('views_values')
      .select('id, value')
      .eq('view_id', viewId)
      .eq('created_at', createdAt)
      .maybeSingle()
  }

  async updateValueById(
    id: string,
    patch: { value: string; needs_sync?: boolean; updated_at?: string },
  ) {
    return this.supabaseService.getClient().from('views_values').update(patch).eq('id', id)
  }

  async updateGaugeValue(viewId: string, createdAt: string, value: string) {
    return this.supabaseService
      .getClient()
      .from('views_values')
      .update({ value, updated_at: new Date().toISOString() })
      .eq('view_id', viewId)
      .eq('created_at', createdAt)
  }

  async findPendingSyncRows(dates: string[]) {
    return this.supabaseService
      .getClient()
      .from('views_values')
      .select(
        'id, view_id, created_at, views!inner(type, connection_id, config, connections!inner(type))',
      )
      .eq('needs_sync', true)
      .in('created_at', dates)
  }

  async markValueSynced(id: string, value: string) {
    return this.supabaseService
      .getClient()
      .from('views_values')
      .update({ value, needs_sync: false, updated_at: new Date().toISOString() })
      .eq('id', id)
  }

  async upsertSingleDayValue(viewId: string, value: string, date: string) {
    const { error: insertErr } = await this.insertValue({
      view_id: viewId,
      value,
      created_at: date,
      needs_sync: false,
    })

    if (insertErr?.code === '23505') {
      return this.updateValue(viewId, date, value)
    }

    return { data: null, error: insertErr }
  }
}
