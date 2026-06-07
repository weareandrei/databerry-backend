import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import type { AuthenticatedRequest } from '../common/types'
import { PeopleService } from './people.service'
import { PeopleInitializationService } from './initializers/people-init.service'

/**
 * `GET /people` read surface for the cross-platform people graph
 * (Phase 1). All routes auth-guarded + user-scoped in the service.
 *
 *   GET /people?projectId=…&search=…&limit=…  → list people
 *   GET /people/:id                            → person + identifiers
 *   GET /people/:id/events?limit=…             → person's timeline
 *
 * No write routes yet — population happens server-side via the
 * matching / ingestion phases, not via client POSTs.
 */
@Controller('people')
@UseGuards(SupabaseAuthGuard)
export class PeopleController {
  constructor(
    private readonly peopleService: PeopleService,
    private readonly initService: PeopleInitializationService,
  ) {}

  /**
   * Kick off people initialization for a connection. Dispatches to
   * the right per-platform initializer by connection type. Body:
   * `{ connectionId, projectId? }` — `projectId` optional for
   * project-scoped connections, required for Common ones.
   *
   * Manual trigger for now (testing + a "Sync people" button
   * later); connection-create hooks will call the same service
   * directly without HTTP.
   */
  @Post('initialize')
  initialize(
    @Req() req: AuthenticatedRequest,
    @Body() body: { connectionId?: string; projectId?: string },
  ) {
    if (!body?.connectionId) {
      throw new BadRequestException('connectionId is required')
    }
    return this.initService.initialize(
      body.connectionId,
      req.authUser.id,
      body.projectId,
    )
  }

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('projectId') projectId: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query param is required')
    }
    return this.peopleService.listPeople(req.authUser.id, projectId, {
      search,
      limit: limit ? Number(limit) : undefined,
    })
  }

  @Get(':id')
  getOne(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.peopleService.getPerson(req.authUser.id, id)
  }

  @Get(':id/events')
  getEvents(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.peopleService.getPersonEvents(req.authUser.id, id, {
      limit: limit ? Number(limit) : undefined,
    })
  }
}
