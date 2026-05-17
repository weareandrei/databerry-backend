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
    @Query('tz') tz: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const normalizedSecondary: SecondaryMetric =
      !secondaryMetric || secondaryMetric === 'null' || secondaryMetric === 'none'
        ? null
        : (secondaryMetric as SecondaryMetric)

    // Validate tz: only allow IANA-style identifiers ([A-Za-z0-9_/+-]). The
    // service re-validates before threading it into HogQL, but rejecting junk
    // here keeps the log line clean and gives a fast 'UTC' fallback.
    const safeTz =
      typeof tz === 'string' && /^[A-Za-z0-9_/+-]+$/.test(tz) ? tz : 'UTC'

    return this.service.fetchChart(
      req.authUser.id,
      projectId,
      dateFrom,
      dateTo,
      mode,
      primaryMetric,
      normalizedSecondary,
      safeTz,
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
    // Default 100 — the panel paginates client-side now, so we want to send
    // a generous batch in one go and let the UI flip pages locally rather
    // than re-fetching per page. 100 is the practical ceiling for a solo-
    // founder-scale project; beyond that, drilling into PostHog directly is
    // the right escape hatch.
    const n = limit ? parseInt(limit, 10) : 100
    return this.service.fetchSources(req.authUser.id, projectId, dateFrom, dateTo, isNaN(n) ? 100 : n)
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

  @Get('countries')
  async countries(
    @Query('projectId') projectId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const n = limit ? parseInt(limit, 10) : 50
    return this.service.fetchCountries(
      req.authUser.id,
      projectId,
      dateFrom,
      dateTo,
      isNaN(n) ? 50 : n,
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
