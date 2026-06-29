import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ConnectionsRepository } from '../connections/connections.repository'
import { PeopleRepository } from './people.repository'
import { PeopleSyncStatus } from './sync-status'
import { StripeSync } from './sync-connectors/stripe.sync'
import { PosthogSync } from './sync-connectors/posthog.sync'

type ConnectionPeopleSyncResult = {
  connectionId: string
  source: string
  processed: number
  error?: string
}

type ProjectPeopleSyncResult = {
  processed: number
  connections: ConnectionPeopleSyncResult[]
}

type UserConnection = {
  id: string
  type: string
}

/**
 * Orchestrates pulling people from connected platforms (Stripe,
 * PostHog, …) into the project's people index. Routes each
 * connection to the right platform sync by `type`.
 */
@Injectable()
export class PeopleSyncService {
  private readonly logger = new Logger(PeopleSyncService.name)

  /**
   * Projects (`userId:projectId`) with a resync running in this process.
   * Lets the `GET /people` read report `isResyncing` across polls and
   * prevents stacking a second concurrent sync for the same project.
   * In-memory → single-instance only; see `startResyncIfStale`.
   */
  private readonly inFlightResyncs = new Set<string>()

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly peopleRepository: PeopleRepository,
    private readonly stripeSync: StripeSync,
    private readonly posthogSync: PosthogSync,
  ) {}

  /** True when a background resync is currently running for this project. */
  isResyncing(userId: string, projectId: string): boolean {
    return this.inFlightResyncs.has(this.resyncKey(userId, projectId))
  }

  /**
   * Auto-resync entry point for the `GET /people` read. If the project's
   * people data is stale (or never synced) AND no resync is already running,
   * kick off `syncPeopleForProject` in the BACKGROUND (not awaited) and return
   * `true`. Returns `true` while an existing resync is in flight, `false` when
   * the data is fresh / nothing to sync.
   *
   * The read endpoint returns the CURRENT people immediately alongside this
   * flag; the frontend polls until it flips back to `false`.
   *
   * Concurrency: the in-flight guard is in-memory, so it dedupes within one
   * process. Across multiple instances two resyncs could overlap — harmless,
   * because the sync itself is idempotent (cursor + unique keys).
   */
  async startResyncIfStale(userId: string, projectId: string): Promise<boolean> {
    const key = this.resyncKey(userId, projectId)
    if (this.inFlightResyncs.has(key)) return true

    let needsResync: boolean
    try {
      needsResync = await this.projectNeedsResync(userId, projectId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Could not evaluate resync need for project ${projectId}: ${detail}`)
      return false
    }
    if (!needsResync) return false
    // Re-check after the await — a concurrent request may have started one.
    if (this.inFlightResyncs.has(key)) return true

    this.inFlightResyncs.add(key)
    void this.runResyncInBackground(userId, projectId, key)
    return true
  }

  /** Run the project sync detached from the request, clearing the guard after. */
  private async runResyncInBackground(
    userId: string,
    projectId: string,
    key: string,
  ): Promise<void> {
    try {
      await this.syncPeopleForProject(userId, projectId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Background resync failed for project ${projectId}: ${detail}`)
    } finally {
      this.inFlightResyncs.delete(key)
    }
  }

  /**
   * A project needs a resync when ANY syncable connection:
   *   - has never synced (no state / no `last_synced_at`), OR
   *   - is mid-backfill (`last_status === Backfilling`) — a resumable scan
   *     the connector wants poked again to continue, OR
   *   - is stale (`last_synced_at` older than the freshness window).
   *
   * It reads only the GENERIC sync-state columns (`last_synced_at`,
   * `last_status`) — never a connector's private `cursor` — so it stays
   * decoupled from how each platform tracks resume position. Returns false
   * when the project has no syncable connections (nothing to do).
   */
  private async projectNeedsResync(userId: string, projectId: string): Promise<boolean> {
    const { data: connections, error } = await this.connectionsRepository.findConnections({
      userId,
      types: PEOPLE_SYNC_CONNECTION_TYPES,
      projectId,
    })
    if (error) throw new Error(error.message)

    const syncableConnections = (connections ?? []) as unknown as UserConnection[]
    if (syncableConnections.length === 0) return false

    const { data: stateRows, error: stateError } =
      await this.peopleRepository.findSyncStateByProject(userId, projectId)
    if (stateError) throw new Error(stateError.message)

    const stateByConnection = new Map<
      string,
      { lastSyncedAt: string | null; status: string | null }
    >()
    for (const row of (stateRows ?? []) as {
      connection_id: string
      last_synced_at: string | null
      last_status: string | null
    }[]) {
      stateByConnection.set(row.connection_id, {
        lastSyncedAt: row.last_synced_at ?? null,
        status: row.last_status ?? null,
      })
    }

    const now = Date.now()
    return syncableConnections.some((connection) => {
      const state = stateByConnection.get(connection.id)
      if (!state || !state.lastSyncedAt) return true // never synced
      if (state.status === PeopleSyncStatus.Backfilling) return true // resumable scan pending
      return now - new Date(state.lastSyncedAt).getTime() > RESYNC_STALENESS_MS
    })
  }

  private resyncKey(userId: string, projectId: string): string {
    return `${userId}:${projectId}`
  }

  /**
   * Sync people for a WHOLE project — loads the user's connections
   * (filtered by syncable types + project), then syncs each in parallel.
   *
   * Connection types that don't provide people data (webhook,
   * sentry, vercel, calendly-not-yet, mcp, …) are skipped — only the
   * ones the dispatcher above knows how to handle.
   *
   * Per-connection failures are swallowed + logged so one broken
   * credential doesn't abort the others; the caller gets the total
   * processed plus a per-connection breakdown.
   */
  async syncPeopleForProject(
    userId: string,
    projectId: string,
  ): Promise<ProjectPeopleSyncResult> {
    const { data: connections, error } =
      await this.connectionsRepository.findConnections({
        userId,
        types: PEOPLE_SYNC_CONNECTION_TYPES,
        projectId,
      })
    if (error) throw new Error(error.message)

    const syncResult = await this.syncPeopleFromConnections(
      (connections ?? []) as unknown as UserConnection[],
      userId,
      projectId,
    )

    this.logger.log(
      `syncProject done  project=${projectId} connections=${syncResult.connections.length} people=${syncResult.processed}`,
    )
    return syncResult
  }

  /**
   * Sync people from each connection in parallel. Per-connection
   * failures are logged and returned in the breakdown without
   * aborting the rest.
   */
  private async syncPeopleFromConnections(
    connections: UserConnection[],
    userId: string,
    projectId: string,
  ): Promise<ProjectPeopleSyncResult> {
    const connectionResults = await Promise.all(
      connections.map(connection =>
        this.syncPeopleFromConnectionSafely(connection, userId, projectId),
      ),
    )

    const processed = connectionResults.reduce(
      (total, result) => total + result.processed,
      0,
    )

    return { processed, connections: connectionResults }
  }

  /** Catches errors so one broken connection doesn't abort project sync. */
  private async syncPeopleFromConnectionSafely(
    connection: UserConnection,
    userId: string,
    projectId: string,
  ): Promise<ConnectionPeopleSyncResult> {
    try {
      const { processed, source } = await this.syncPeopleFromConnection(
        connection,
        userId,
        projectId,
      )
      return { connectionId: connection.id, source, processed }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `syncProject: connection ${connection.id} (${connection.type}) failed — ${error}`,
      )
      return {
        connectionId: connection.id,
        source: connection.type,
        processed: 0,
        error,
      }
    }
  }

  async syncPeopleFromConnection(
    connection: UserConnection,
    userId: string,
    projectId: string,
  ): Promise<{ processed: number; source: string }> {
    switch (connection.type) {
      case 'stripe':
      case 'stripe_manual': {
        const { processed } = await this.stripeSync.sync(
          connection.id,
          projectId,
          userId,
        )
        return { processed, source: 'stripe' }
      }
      case 'posthog': {
        const { processed } = await this.posthogSync.sync(
          connection.id,
          projectId,
          userId,
        )
        return { processed, source: 'posthog' }
      }
      default:
        throw new BadRequestException(
          `People sync not yet supported for connection type '${connection.type}'.`,
        )
    }
  }
}

/**
 * Connection types that expose customers/users and have a people
 * sync wired. Keep in sync with the `switch` in
 * `syncPeopleFromConnection` — add a type here AND a case there together.
 */
const PEOPLE_SYNC_CONNECTION_TYPES = ['stripe', 'stripe_manual', 'posthog']

/**
 * How long a connection's people data is considered fresh. A `GET /people`
 * with `autoResync` only triggers a background resync once data is older than
 * this — so normal page loads don't hammer the platforms.
 */
const RESYNC_STALENESS_MS = 5 * 60 * 1000 // 5 minutes
