import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { ViewsService } from './views.service'
import type { CreateViewDto } from './views.service'
import type { AuthenticatedRequest } from '../common/types'

@Controller('views')
@UseGuards(SupabaseAuthGuard)
export class ViewsController {
  constructor(private readonly viewsService: ViewsService) {}

  @Get('pinned')
  getPinned(@Req() req: AuthenticatedRequest) {
    return this.viewsService.getPinnedViews(req.authUser.id)
  }

  /**
   * Returns the user's total view count across all projects, used
   * by the sidebar plan card. Declared BEFORE the catch-all `@Get`
   * below so the literal `count` segment matches first (otherwise
   * `getViews` would try to interpret "count" as a folder filter
   * and 400).
   *
   * Cheap query: Supabase HEAD request with `count: 'exact'` — no
   * row payload, just the number.
   */
  @Get('count')
  async getCount(@Req() req: AuthenticatedRequest) {
    const count = await this.viewsService.countByUser(req.authUser.id)
    return { count }
  }

  @Get()
  getViews(
    @Query('folderId') folderId: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('date') date: string | undefined,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    // Resolve date range: explicit dateFrom/dateTo take priority;
    // legacy `date` param maps to single-day range for backward compat
    const from = dateFrom ?? date
    const to   = dateTo ?? date

    if (projectId) {
      return this.viewsService.getViewsByProject(projectId, req.authUser.id, from, to)
    }
    return this.viewsService.getViewsByFolder(folderId!, req.authUser.id, from, to)
  }

  @Post()
  create(@Body() dto: CreateViewDto, @Req() req: AuthenticatedRequest) {
    return this.viewsService.createView(dto, req.authUser.id)
  }

  /**
   * Persist a new ordering for one container's views (drag-and-drop
   * reorder). `folderId` is nullable — `null` targets the project-root
   * container; a UUID targets a folder. `orderedViewIds` is the full
   * desired sequence; the service rewrites every view's `position` to
   * match its index in the array. Returns 204; the frontend has already
   * optimistically reordered.
   *
   * Declared BEFORE `@Patch(':id')` so the literal `reorder` segment
   * matches before the catch-all `:id` route would swallow it as a
   * (malformed) view id.
   */
  @Patch('reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  reorder(
    @Body()
    dto: { projectId: string; folderId: string | null; orderedViewIds: string[] },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.viewsService.reorderViews(
      req.authUser.id,
      dto.projectId,
      dto.folderId ?? null,
      dto.orderedViewIds,
    )
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: { config?: Record<string, unknown>; name?: string; connectionId?: string | null },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.viewsService.updateView(id, dto, req.authUser.id)
  }

  @Post(':id/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  pin(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.viewsService.pinView(id, req.authUser.id)
  }

  @Post(':id/unpin')
  @HttpCode(HttpStatus.NO_CONTENT)
  unpin(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.viewsService.unpinView(id, req.authUser.id)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.viewsService.deleteView(id, req.authUser.id)
  }
}
