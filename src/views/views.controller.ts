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
