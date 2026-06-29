import type { ViewsRepository } from './views.repository'

/**
 * Marks a views_values row for (viewId, date) as needing a scheduler sync.
 *
 * - If no row exists yet: inserts a placeholder (value='0', needs_sync=true).
 * - If a row already exists: sets needs_sync=true without touching the value.
 *
 * Uses insert-then-update-on-conflict so concurrent webhook calls are safe
 * against the unique constraint on (view_id, created_at).
 */
export async function markNeedsSync(
  viewId: string,
  date: string,
  viewsRepository: ViewsRepository,
): Promise<void> {
  const { error } = await viewsRepository.markValueNeedsSync(viewId, date)
  if (error) throw new Error(error.message)
}
