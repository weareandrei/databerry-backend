import type { SupabaseService } from '../supabase/supabase.service'

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
  client: ReturnType<SupabaseService['getClient']>,
): Promise<void> {
  const { error } = await client
    .from('views_values')
    .insert({ view_id: viewId, created_at: date, value: '0', needs_sync: true })

  if (error?.code === '23505') {
    // Unique constraint hit — row already exists; just raise the flag, preserve the value
    await client
      .from('views_values')
      .update({ needs_sync: true })
      .eq('view_id', viewId)
      .eq('created_at', date)
  }
}
