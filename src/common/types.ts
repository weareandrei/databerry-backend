/** Extends the Express Request with the user injected by SupabaseAuthGuard */
export interface AuthenticatedRequest {
  authUser: { id: string }
}

/**
 * Chart/period granularity selected by the dashboard's date-mode
 * picker. The single source of truth for the union that used to be
 * re-declared per provider module (`ChartMode` in stripe/GA views,
 * `OverviewMode` in project-overview, …).
 */
export type ChartMode = 'daily' | 'weekly' | 'monthly'

/**
 * Bucket sizes for the per-provider "N per bucket" queries: daily
 * windows bucket by hour, anything longer buckets by day. Weekly /
 * monthly modes aggregate daily buckets via the shared chart grid.
 */
export type BucketGranularity = 'hourly' | 'daily'
