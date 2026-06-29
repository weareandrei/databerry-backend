/**
 * Normalized people-sync status for `connection_sync_state.last_status`.
 *
 * This is the SHARED, platform-agnostic signal the orchestrator
 * (`PeopleSyncService`) reads to decide whether a project needs another
 * resync. It deliberately knows nothing about any connector's private
 * `cursor` shape (Stripe's `resumeAfterId`, PostHog's event watermark, …) —
 * each connector translates its own "am I done?" into one of these values.
 */
export const PeopleSyncStatus = {
  /** Caught up for now. Refreshing is governed purely by staleness. */
  Initialized: 'people_initialized',
  /**
   * A RESUMABLE backfill is still in progress — re-triggering the sync soon
   * continues it from the connector's saved cursor. Only set this when poking
   * the connector again actually makes forward progress (e.g. Stripe's
   * `starting_after` scan); connectors that restart from scratch must NOT.
   */
  Backfilling: 'backfilling',
} as const

export type PeopleSyncStatus = (typeof PeopleSyncStatus)[keyof typeof PeopleSyncStatus]
