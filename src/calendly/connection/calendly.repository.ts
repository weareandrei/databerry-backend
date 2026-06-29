import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

@Injectable()
export class CalendlyRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  insertOAuthState(row: { state: string; user_id: string; code_verifier: string }) {
    return this.supabaseService.getClient().from('calendly_oauth_state').insert(row)
  }

  findOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('calendly_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()
  }

  deleteOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('calendly_oauth_state')
      .delete()
      .eq('state', state)
  }

  insert(row: {
    connection_id: string
    access_token: string
    refresh_token: string
    expires_at: string
    user_uri: string
    organization_uri: string
  }) {
    return this.supabaseService.getClient().from('connections_calendly').insert(row)
  }

  findWithUserJoin(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_calendly')
      .select('access_token, refresh_token, expires_at, connections!inner(user_id)')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  updateTokens(
    connectionId: string,
    row: { access_token: string; refresh_token: string; expires_at: string },
  ) {
    return this.supabaseService
      .getClient()
      .from('connections_calendly')
      .update(row)
      .eq('connection_id', connectionId)
  }

  findUserUri(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_calendly')
      .select('user_uri')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }
}
