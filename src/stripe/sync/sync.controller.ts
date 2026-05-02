import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import type { AuthenticatedRequest } from '../../common/types'
import { StripeLiveSyncService } from './live-sync.service'

interface ReloadBody {
  /** How many days back to pull. Defaults to 30 if omitted. */
  days?: unknown
}

const RELOAD_DAYS_MIN = 1
const RELOAD_DAYS_MAX = 90 // hard cap — anything more is the backfill path's concern

@UseGuards(SupabaseAuthGuard)
@Controller('stripe')
export class StripeSyncController {
  constructor(private readonly liveSync: StripeLiveSyncService) {}

  /**
   * Pull anything that's happened since `last_synced_at` (charges only).
   * Throttled at 60s on the server — successive calls within that window
   * return `{ skipped: 'recent' }` cheaply. Frontend calls this on
   * dashboard mount; the response always returns within ~2s (timeout
   * ceiling), even if the underlying sync continues in the background.
   */
  @Post('connections/:connectionId/sync-now')
  async syncNow(
    @Param('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.liveSync.syncToNow(connectionId, req.authUser.id)
  }

  /**
   * User-initiated full reload over the last N days (default 30) — fired
   * from the kebab menu next to "Delete" on the connections list. No
   * server-side throttle — the user clicked.
   */
  @Post('connections/:connectionId/reload')
  async reload(
    @Param('connectionId') connectionId: string,
    @Body() body: ReloadBody,
    @Req() req: AuthenticatedRequest,
  ) {
    const days = parseDays(body?.days)
    return this.liveSync.reloadRecent(connectionId, req.authUser.id, days)
  }
}

function parseDays(raw: unknown): number {
  if (raw === undefined || raw === null) return 30
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequestException('days must be an integer')
  }
  if (n < RELOAD_DAYS_MIN || n > RELOAD_DAYS_MAX) {
    throw new BadRequestException(
      `days must be between ${RELOAD_DAYS_MIN} and ${RELOAD_DAYS_MAX}`,
    )
  }
  return n
}
