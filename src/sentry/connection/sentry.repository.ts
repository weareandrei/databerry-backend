import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

@Injectable()
export class SentryRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  insertOAuthState(row: { state: string; user_id: string; name: string | null }) {
    return this.supabaseService.getClient().from('sentry_oauth_state').insert(row)
  }

  findOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('sentry_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()
  }

  deleteOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('sentry_oauth_state')
      .delete()
      .eq('state', state)
  }

  insert(row: {
    connection_id: string
    access_token: string
    refresh_token: string
    expires_at: string
    org_slug: string
    installation_id: string
  }) {
    return this.supabaseService.getClient().from('connections_sentry').insert(row)
  }

  findWithUserJoin(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_sentry')
      .select(
        'access_token, refresh_token, expires_at, installation_id, connections!inner(user_id)',
      )
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  updateTokens(
    connectionId: string,
    row: { access_token: string; refresh_token: string; expires_at: string },
  ) {
    return this.supabaseService
      .getClient()
      .from('connections_sentry')
      .update(row)
      .eq('connection_id', connectionId)
  }

  findOrgSlug(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_sentry')
      .select('org_slug')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }
}
