import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConnectionsRepository } from '../connections/connections.repository'
import { PosthogLifecycleService } from '../posthog/lifecycle/hog-function'
import { ViewsRepository } from './views.repository'

/**
 * View types that *intentionally* have no `connection_id` — the server
 * resolves the right provider per-request via `pickTrafficProvider`. Auto-
 * reattach skips these.
 */
// Connection-less view types — server resolves the right provider per
// request (via `pickTrafficProvider` for the chart half, the connection
// table for revenue, etc.). Auto-reattach skips these because there's
// no per-view connection FK to repair.
//
// `custom_chart` joins the existing pair as a standalone chart variant
// (no paired sources panel) — same connection-less data resolution as
// `project_overview`, different render lane on the frontend.
const COMPOSITE_VIEW_TYPES = new Set([
  'project_overview',
  'project_overview_sources',
  'custom_chart',
])
const COMPOSITE_CONNECTION_TYPE = 'composite'

export interface CreateViewDto {
  projectId: string
  folderId?: string
  connectionId?: string | null
  connectionType: string
  type: string
  name: string
  config?: Record<string, unknown>
}

@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name)

  constructor(
    private readonly viewsRepository: ViewsRepository,
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly posthogLifecycleService: PosthogLifecycleService,
  ) {}

  async getViewsByFolder(folderId: string, userId: string, dateFrom?: string, dateTo?: string) {
    this.logger.log(
      `\n  ► getViewsByFolder\n  folderId : ${folderId}\n  userId   : ${userId}\n  dateFrom : ${dateFrom ?? 'none'}\n  dateTo   : ${dateTo ?? 'none'}`,
    )

    const { data, error } = await this.viewsRepository.findByFolderWithValues(folderId, userId)

    if (error) throw new Error(error.message)
    const healed = await this.healOrphans(data ?? [], userId)
    return healed.map(row => this.toCamel(row, dateFrom, dateTo))
  }

  async getViewsByProject(projectId: string, userId: string, dateFrom?: string, dateTo?: string) {
    this.logger.log(
      `\n  ► getViewsByProject\n  projectId : ${projectId}\n  userId    : ${userId}\n  dateFrom  : ${dateFrom ?? 'none'}\n  dateTo    : ${dateTo ?? 'none'}`,
    )

    const { data, error } = await this.viewsRepository.findByProjectWithValues(projectId, userId)

    if (error) throw new Error(error.message)
    const healed = await this.healOrphans(data ?? [], userId)
    return healed.map(row => this.toCamel(row, dateFrom, dateTo))
  }

  /**
   * Return the total number of views owned by this user across all
   * their projects and folders. Used by the sidebar plan card to
   * show "X / Y views" usage without having to eagerly fetch every
   * view (which is expensive — `getViewsByFolder` is per-folder
   * and joins the values table).
   *
   * Uses Supabase's `head: true` + `count: 'exact'` so the query
   * returns just the row count, no data — single roundtrip, no
   * row payload. Returns 0 on error rather than throwing because
   * the sidebar bar gracefully renders zero (and the controller
   * surfaces the failure to logs).
   */
  async countByUser(userId: string): Promise<number> {
    const { count, error } = await this.viewsRepository.countByUser(userId)
    if (error) {
      this.logger.warn(`countByUser failed (user=${userId}): ${error.message}`)
      return 0
    }
    return count ?? 0
  }

  async getPinnedViews(userId: string) {
    this.logger.log(`\n  ► getPinnedViews\n  userId : ${userId}`)

    const { data, error } = await this.viewsRepository.findPinnedWithValues(userId)

    if (error) throw new Error(error.message)
    const healed = await this.healOrphans(data ?? [], userId)
    return healed.map(row => this.toCamel(row))
  }

  async pinView(viewId: string, userId: string) {
    const { error } = await this.viewsRepository.updatePinned(viewId, userId, true)

    if (error) throw new Error(error.message)
  }

  async unpinView(viewId: string, userId: string) {
    const { error } = await this.viewsRepository.updatePinned(viewId, userId, false)

    if (error) throw new Error(error.message)
  }

  /**
   * Persist a new ordering for the views inside one container — i.e. one
   * (project_id, folder_id) bucket. `orderedIds` is the desired sequence;
   * each view gets `position = its index in the array`, so a single
   * reorder rewrites every affected view's position to a clean 0..N-1
   * sequence. That's simpler than fractional indexing and fine at the
   * ~10–20 views per container we expect; the cost is O(N) updates per
   * reorder, which is well under any latency budget.
   *
   * Security: every UPDATE is gated by `user_id` AND `project_id` AND
   * `folder_id`, so an attacker can't reach into another user's grid by
   * supplying ids they don't own — those rows simply don't match the
   * WHERE clause and are left untouched. The frontend always passes the
   * full container's id list (not a partial), but partial lists are
   * still safe — they'd just leave the un-named views at their existing
   * positions, which secondary `created_at` sorting tolerates.
   *
   * `folderId === null` represents the project-root container; we
   * dispatch to `.is('folder_id', null)` for those (vs `.eq` for
   * folder-scoped containers) because PostgREST distinguishes the two.
   *
   * The composite project_overview pair is excluded from this set at
   * the FRONTEND layer (it's rendered above the sortable container and
   * never participates in DnD). The backend doesn't need to know about
   * that anchor — it just writes whatever ordered ids the client sends.
   */
  async reorderViews(
    userId: string,
    projectId: string,
    folderId: string | null,
    orderedIds: string[],
  ): Promise<void> {
    this.logger.log(
      `\n  ► reorderViews\n  projectId : ${projectId}\n  folderId  : ${folderId ?? 'none (project root)'}\n  userId    : ${userId}\n  count     : ${orderedIds.length}`,
    )

    if (orderedIds.length === 0) return

    const results = await Promise.all(
      orderedIds.map((id, position) =>
        this.viewsRepository.updatePosition(id, userId, projectId, folderId, position),
      ),
    )

    for (const r of results) {
      if (r.error) throw new Error(`reorderViews failed: ${r.error.message}`)
    }
  }

  /**
   * Compute the next `position` value for a new view in a given
   * container. Returns 0 for the first view, otherwise `max(position)
   * + 1` so new views append. Folder-scoped vs project-root containers
   * dispatch on `folderId` the same way `reorderViews` does (`.is` for
   * NULL, `.eq` otherwise).
   *
   * `not('position', 'is', null)` filters out the fallback nulls so
   * the "max" we read is the true highest placed position. Without
   * this, a single null-position row could surface as the top hit
   * under PostgREST's default ordering and we'd hand back `NaN` or
   * collide with position 0. The filter keeps insertions correct
   * even if legacy data ever leaks through.
   */
  private async nextPositionFor(
    userId: string,
    projectId: string,
    folderId: string | null,
  ): Promise<number> {
    const { data, error } = await this.viewsRepository.findMaxPosition(
      userId,
      projectId,
      folderId,
    )
    if (error) throw new Error(`nextPositionFor failed: ${error.message}`)
    if (!data) return 0
    const current = data.position as number | null
    return current == null ? 0 : current + 1
  }

  async createView(dto: CreateViewDto, userId: string) {
    this.logger.log(
      `\n  ► createView\n  projectId      : ${dto.projectId}\n  folderId       : ${dto.folderId ?? 'none (project root)'}\n  connectionId   : ${dto.connectionId}\n  connectionType : ${dto.connectionType}\n  name           : ${dto.name}`,
    )

    // New views append to the end of their container — the user's
    // expected mental model ("the thing I just made shows up at the
    // bottom"). Computed once up-front and threaded into both insert
    // paths (PostHog + everything else) so the two branches stay in
    // sync. See `nextPositionFor` for the read.
    const position = await this.nextPositionFor(
      userId,
      dto.projectId,
      dto.folderId ?? null,
    )

    const baseInsert = {
      project_id: dto.projectId,
      folder_id: dto.folderId ?? null,
      connection_id: dto.connectionId ?? null,
      connection_type: dto.connectionType,
      type: dto.type,
      name: dto.name,
      config: dto.config ?? {},
      is_pinned: false,
      user_id: userId,
      position,
    }

    // For PostHog views: create Hog Function first — if it fails, abort
    if (dto.connectionType === 'posthog') {
      const eventName = (dto.config?.eventName as string) ?? dto.name

      const { data: tempView, error: tempError } = await this.viewsRepository.insert(baseInsert)

      if (tempError) {
        this.logger.error(`  ✗ createView failed\n  ${tempError.message}`)
        throw new Error(tempError.message)
      }

      if (!dto.connectionId) {
        throw new Error('PostHog views require a connectionId')
      }
      // Register the live auto-update destination (hog function). If this
      // fails — most often because the API key lacks the `hog_function:write`
      // scope — DON'T abort: keep the view and record that it has no hog
      // function (config.hogFunctionId = null). The UI reads that flag to
      // warn the user, and we never re-check PostHog for it. The view still
      // works on manual refresh; it just won't update live.
      let hogFunctionId: string | null = null
      try {
        hogFunctionId = await this.posthogLifecycleService.createHogFunction(
          dto.connectionId,
          tempView.id as string,
          eventName,
        )
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.logger.warn(`  ⚠ hog function failed (view kept, no live updates): ${detail}`)
      }

      const finalConfig = { ...(dto.config ?? {}), hogFunctionId: hogFunctionId ?? null }
      await this.viewsRepository.updateConfig(tempView.id as string, finalConfig)

      this.logger.log(
        hogFunctionId
          ? `  ✓ view created and hog function registered  id: ${tempView.id}`
          : `  ⚠ view created WITHOUT hog function (no live updates)  id: ${tempView.id}`,
      )
      return this.toCamel({ ...tempView, config: finalConfig })
    }

    // Non-PostHog views — create directly
    const { data, error } = await this.viewsRepository.insert(baseInsert)

    if (error) {
      this.logger.error(`  ✗ createView failed\n  ${error.message}`)
      throw new Error(error.message)
    }

    this.logger.log(`  ✓ view created  id: ${data.id}`)
    return this.toCamel(data)
  }

  async updateView(
    viewId: string,
    dto: { config?: Record<string, unknown>; name?: string; connectionId?: string | null },
    userId: string,
  ) {
    const patch: Record<string, unknown> = {}
    if (dto.config !== undefined) patch.config = dto.config
    if (dto.name !== undefined) patch.name = dto.name

    // Reassigning the connection: validate the chosen connection belongs to
    // this user, matches the view's connection_type, and is project-eligible
    // (project-scoped to the view's project, or Common). Mismatches throw 400
    // so the frontend doesn't silently pin a wrong-typed connection that the
    // live-value endpoints will then 4xx on.
    if (dto.connectionId !== undefined) {
      if (dto.connectionId === null) {
        patch.connection_id = null
      } else {
        const { data: view } = await this.viewsRepository.findProjectAndConnectionType(
          viewId,
          userId,
        )
        if (!view) throw new NotFoundException('View not found')

        const { data: conn } = await this.connectionsRepository.findTypeAndProjectId(
          dto.connectionId,
          userId,
        )
        if (!conn) throw new NotFoundException('Connection not found')
        if (conn.type !== view.connection_type) {
          throw new BadRequestException(
            `Connection type "${conn.type}" does not match view connection_type "${view.connection_type}"`,
          )
        }
        if (conn.project_id != null && conn.project_id !== view.project_id) {
          throw new BadRequestException(
            'Connection is scoped to a different project and is not eligible for this view',
          )
        }
        patch.connection_id = dto.connectionId
      }
    }

    if (Object.keys(patch).length === 0) {
      // No-op — return current row
      const { data } = await this.viewsRepository.findWithValues(viewId, userId)
      if (!data) throw new NotFoundException('View not found')
      return this.toCamel(data)
    }

    const { data, error } = await this.viewsRepository.update(viewId, userId, patch)

    if (error || !data) throw new NotFoundException('View not found')
    this.logger.log(`  ✓ view updated  id: ${viewId}`)
    return this.toCamel(data)
  }

  async deleteView(viewId: string, userId: string) {
    this.logger.log(`\n  ► deleteView\n  viewId : ${viewId}\n  userId : ${userId}`)

    const { data: view } = await this.viewsRepository.findConnectionAndConfig(viewId, userId)

    const { error } = await this.viewsRepository.delete(viewId, userId)

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
      this.posthogLifecycleService
        .deleteHogFunction(view.connection_id as string, hogFunctionId)
        .catch(err => {
          this.logger.error(`  ✗ deleteHogFunction failed silently\n  ${err.message}`)
        })
    }
  }

  // Shared by StripeManualService, CalendlyService, GoogleAnalyticsService, PosthogViewsService
  // Upserts the value for a view on the given date (defaults to today) and clears needs_sync.
  // Uses insert-then-update-on-conflict to be safe against concurrent calls.
  async upsertValue(connectionId: string, viewType: string, value: string, date?: string): Promise<void> {
    const targetDate = date ?? new Date().toISOString().split('T')[0]

    const { data: view } = await this.viewsRepository.findIdByConnectionAndType(
      connectionId,
      viewType,
    )

    if (!view) {
      this.logger.warn(`  ⚠ No view found for connectionId=${connectionId} type=${viewType}`)
      return
    }

    const viewId = view.id as string
    const { error } = await this.viewsRepository.insertValue({
      view_id: viewId,
      value,
      created_at: targetDate,
      needs_sync: false,
    })

    if (error?.code === '23505') {
      await this.viewsRepository.updateValue(viewId, targetDate, value)
    }
  }

  /**
   * Auto-reattach views to a fresh connection when the original is gone.
   *
   * Why this exists: when a user deletes a stale connection (e.g. revoked
   * GA refresh token) and creates a new one of the same type for the same
   * project, the project-overview chart self-heals because it resolves
   * its provider per-request via `pickTrafficProvider`. Per-view tiles
   * don't — they store `connection_id` on the row and become orphans.
   *
   * Heuristic (per the user's request — strict, no surprises):
   *   1. Skip composite views (`project_overview`, `project_overview_sources`,
   *      and any row tagged `connection_type: 'composite'`).
   *   2. A row is "orphan" if `connection_id` is null OR points to a row
   *      that no longer exists under this user.
   *   3. For each orphan, look for project-scoped connections matching
   *      `(view.project_id, view.connection_type)`. If exactly 1 → use it.
   *      If 2+ → ambiguous, leave the view orphaned. If 0 → fall through
   *      to Common (`project_id IS NULL`) with the same exactly-1 rule.
   *      If still no unique pick → leave orphaned (the user picks via the
   *      reassignment dialog).
   *
   * The mutation is in-place on the result rows so the caller's `.toCamel()`
   * pass returns the healed `connection_id`. Updates are fire-and-await per
   * row (volume is tiny — at most a handful of orphans per fetch).
   */
  private async healOrphans(
    rows: Record<string, unknown>[],
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return rows

    // Anything we'd consider for healing — exclude composites up-front.
    const candidates = rows.filter(
      r =>
        !COMPOSITE_VIEW_TYPES.has(r.type as string) &&
        r.connection_type !== COMPOSITE_CONNECTION_TYPE,
    )
    if (candidates.length === 0) return rows

    const { data: connections } = await this.connectionsRepository.findAllByUserId(userId)

    const conns = (connections ?? []) as { id: string; type: string; project_id: string | null }[]
    const validIds = new Set(conns.map(c => c.id))

    // Index by (type, project_id) so the per-view pick is O(1). Use empty
    // string sentinel for Common since Map keys can't be null.
    const byKey = new Map<string, string[]>()
    const keyFor = (type: string, projectId: string | null) => `${type}|${projectId ?? ''}`
    for (const c of conns) {
      const k = keyFor(c.type, c.project_id)
      const list = byKey.get(k) ?? []
      list.push(c.id)
      byKey.set(k, list)
    }

    const updates: { viewId: string; connectionId: string }[] = []
    for (const v of candidates) {
      const currentId = v.connection_id as string | null
      const isOrphan = !currentId || !validIds.has(currentId)
      if (!isOrphan) continue

      const type = v.connection_type as string
      const projectId = v.project_id as string

      // Project-scoped first.
      const scoped = byKey.get(keyFor(type, projectId)) ?? []
      let pick: string | null = null
      if (scoped.length === 1) {
        pick = scoped[0]
      } else if (scoped.length === 0) {
        // Fall through to Common only when there's nothing project-scoped at
        // all — if the user has multiple project-scoped connections the
        // intent is ambiguous, don't quietly pick a Common one over them.
        const common = byKey.get(keyFor(type, null)) ?? []
        if (common.length === 1) pick = common[0]
      }

      if (pick) {
        v.connection_id = pick
        updates.push({ viewId: v.id as string, connectionId: pick })
      }
    }

    if (updates.length > 0) {
      this.logger.log(
        `  ↻ healOrphans  auto-attached ${updates.length} view(s) to fresh connections`,
      )
      // Per-row updates — Supabase has no batched-by-id update without RPC,
      // and the orphan count is small in practice.
      await Promise.all(
        updates.map(u =>
          this.viewsRepository.updateConnectionId(u.viewId, userId, u.connectionId),
        ),
      )
    }

    return rows
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

    if (filtered.length === 0) return '0'

    // Gauge types → return the latest value in range (no sum)
    const isGauge = viewType.includes('gauge') || viewType.includes('mrr') || viewType === 'ga_active_users'
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
