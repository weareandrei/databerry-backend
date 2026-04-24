import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import {
  ProjectOverviewService,
  type OverviewMode,
  type PrimaryMetric,
  type SecondaryMetric,
} from './project-overview.service'
import type { AuthenticatedRequest } from '../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('project-overview')
export class ProjectOverviewController {
  constructor(private readonly service: ProjectOverviewService) {}

  @Get('chart')
  async chart(
    @Query('projectId') projectId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('mode') mode: OverviewMode,
    @Query('primaryMetric') primaryMetric: PrimaryMetric,
    @Query('secondaryMetric') secondaryMetric: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const normalizedSecondary: SecondaryMetric =
      !secondaryMetric || secondaryMetric === 'null' || secondaryMetric === 'none'
        ? null
        : (secondaryMetric as SecondaryMetric)

    return this.service.fetchChart(
      req.authUser.id,
      projectId,
      dateFrom,
      dateTo,
      mode,
      primaryMetric,
      normalizedSecondary,
    )
  }

  @Get('sources')
  async sources(
    @Query('projectId') projectId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const n = limit ? parseInt(limit, 10) : 10
    return this.service.fetchSources(req.authUser.id, projectId, dateFrom, dateTo, isNaN(n) ? 10 : n)
  }

  @Get('users')
  async users(
    @Query('projectId') projectId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const n = limit ? parseInt(limit, 10) : 100
    return this.service.fetchUsers(
      req.authUser.id,
      projectId,
      dateFrom,
      dateTo,
      isNaN(n) ? 100 : n,
    )
  }

  @Get('conversion-events')
  async conversionEvents(
    @Query('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.listConversionEvents(req.authUser.id, connectionId)
  }
}
