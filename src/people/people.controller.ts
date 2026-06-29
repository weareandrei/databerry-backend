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
import { PeopleSyncService } from './people-sync.service'

/**
 * `GET /people` read surface for the cross-platform people graph
 * (Phase 1). All routes auth-guarded + user-scoped in the service.
 *
 *   GET /people?projectId=…&search=…&limit=…&autoResync=  → { people, isResyncing }
 *   GET /people/:id                            → person + identifiers
 *   GET /people/:id/events?limit=…             → person's timeline
 *
 * Write: `POST /people/sync` — populate the people index from all
 * project connections. Population otherwise happens server-side.
 */
@Controller('people')
@UseGuards(SupabaseAuthGuard)
export class PeopleController {
  constructor(
    private readonly peopleService: PeopleService,
    private readonly peopleSyncService: PeopleSyncService,
  ) {}

  /**
   * "Sync people" — populate the project's people index from ALL its
   * people-source connections in one call. Backs the empty-state
   * button + the 3-dots menu item in the Users view. Body:
   * `{ projectId }`.
   */
  @Post('sync')
  sync(
    @Req() req: AuthenticatedRequest,
    @Body() body: { projectId?: string },
  ) {
    if (!body?.projectId) {
      throw new BadRequestException('projectId is required')
    }
    return this.peopleSyncService.syncPeopleForProject(req.authUser.id, body.projectId)
  }

  /**
   * List a project's people (current state) plus `isResyncing`.
   *
   * With `autoResync` (default true) we check whether the project's people
   * data is stale and, if so, kick off a background resync — returning the
   * people we have NOW immediately and `isResyncing: true` so the frontend can
   * show a "refreshing…" state and poll until it flips to `false`. Pass
   * `autoResync=false` to read without ever triggering a sync.
   */
  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('projectId') projectId: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('autoResync') autoResync?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query param is required')
    }

    const people = await this.peopleService.listPeople(req.authUser.id, projectId, {
      search,
      limit: limit ? Number(limit) : undefined,
    })

    // Default on; only an explicit `autoResync=false` disables it.
    const shouldAutoResync = autoResync !== 'false'
    const isResyncing = shouldAutoResync
      ? await this.peopleSyncService.startResyncIfStale(req.authUser.id, projectId)
      : this.peopleSyncService.isResyncing(req.authUser.id, projectId)

    return { people, isResyncing }
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
