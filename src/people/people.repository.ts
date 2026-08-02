import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class PeopleRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  // ── people ────────────────────────────────────────────────────

  listByProject(
    userId: string,
    projectId: string,
    opts: { limit: number; search?: string },
  ) {
    let query = this.supabaseService
      .getClient()
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(opts.limit)

    if (opts.search) {
      query = query.or(`primary_email.ilike.${opts.search},display_name.ilike.${opts.search}`)
    }

    return query
  }

  findById(userId: string, personId: string) {
    return this.supabaseService
      .getClient()
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()
  }

  findIdById(userId: string, personId: string) {
    return this.supabaseService
      .getClient()
      .from('people')
      .select('id')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()
  }

  insert(row: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('people')
      .insert(row)
      .select('id')
      .single()
  }

  findIdsForMerge(userId: string, personIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('people')
      .select('id, created_at')
      .eq('user_id', userId)
      .in('id', personIds)
      .order('created_at', { ascending: true })
  }

  deleteByIds(userId: string, personIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('people')
      .delete()
      .eq('user_id', userId)
      .in('id', personIds)
  }

  /** Drop every person in a project (identifiers/events cascade). */
  deleteByProject(userId: string, projectId: string) {
    return this.supabaseService
      .getClient()
      .from('people')
      .delete()
      .eq('user_id', userId)
      .eq('project_id', projectId)
  }

  countByProject(userId: string, projectId: string) {
    return this.supabaseService
      .getClient()
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('project_id', projectId)
  }

  findEnrichmentFields(userId: string, personId: string) {
    return this.supabaseService
      .getClient()
      .from('people')
      .select('primary_email, display_name, country, initial_source, last_seen_at')
      .eq('user_id', userId)
      .eq('id', personId)
      .maybeSingle()
  }

  update(userId: string, personId: string, patch: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('people')
      .update(patch)
      .eq('user_id', userId)
      .eq('id', personId)
  }

  // ── people_identifiers ────────────────────────────────────────

  findIdentifiersByPersonId(userId: string, personId: string) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('*')
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('created_at', { ascending: true })
  }

  findMatchingPersonIds(userId: string, projectId: string, orClause: string) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('person_id')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .or(orClause)
  }

  findIdentifiersByPersonIds(userId: string, personIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('id, source, external_id')
      .eq('user_id', userId)
      .in('person_id', personIds)
  }

  updateIdentifierPersonId(id: string, personId: string) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .update({ person_id: personId })
      .eq('id', id)
  }

  deleteIdentifierById(id: string) {
    return this.supabaseService.getClient().from('people_identifiers').delete().eq('id', id)
  }

  upsertIdentifiers(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .upsert(rows, {
        onConflict: 'project_id,source,external_id',
        ignoreDuplicates: false,
      })
  }

  findIdentifiersByConnectionSourcePage(
    userId: string,
    connectionId: string,
    source: string,
    from: number,
    to: number,
  ) {
    return this.supabaseService
      .getClient()
      .from('people_identifiers')
      .select('external_id, person_id')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('source', source)
      .range(from, to)
  }

  // ── people_events ─────────────────────────────────────────────

  findEventsByPersonId(userId: string, personId: string, limit: number) {
    return this.supabaseService
      .getClient()
      .from('people_events')
      .select(
        'id, occurred_at, properties, source_event_id, connection_id, event_definitions(event_key, display_name, source)',
      )
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('occurred_at', { ascending: false })
      .limit(limit)
  }

  upsertEvents(rows: Record<string, unknown>[]) {
    return this.supabaseService
      .getClient()
      .from('people_events')
      .upsert(rows, {
        onConflict: 'connection_id,source_event_id',
        ignoreDuplicates: false,
      })
  }

  updateEventPersonIdForLosers(userId: string, survivorId: string, loserIds: string[]) {
    return this.supabaseService
      .getClient()
      .from('people_events')
      .update({ person_id: survivorId })
      .eq('user_id', userId)
      .in('person_id', loserIds)
  }

  deleteSyntheticFirstSeen(userId: string, connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('people_events')
      .delete()
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .like('source_event_id', '%:first_seen')
  }

  // ── event_definitions ─────────────────────────────────────────

  upsertEventDefinition(row: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('event_definitions')
      .upsert(row, { onConflict: 'connection_id,event_key', ignoreDuplicates: false })
      .select('id')
      .single()
  }

  // ── connection_sync_state ─────────────────────────────────────

  findLastEventAt(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .select('last_event_at')
      .eq('connection_id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findSyncCursor(connectionId: string, userId: string) {
    return this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .select('cursor')
      .eq('connection_id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
  }

  findSyncStateByProject(userId: string, projectId: string) {
    return this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .select('connection_id, last_synced_at, last_status')
      .eq('user_id', userId)
      .eq('project_id', projectId)
  }

  upsertSyncState(row: Record<string, unknown>) {
    return this.supabaseService
      .getClient()
      .from('connection_sync_state')
      .upsert(row, { onConflict: 'connection_id' })
  }
}
