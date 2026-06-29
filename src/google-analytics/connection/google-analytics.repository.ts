import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

@Injectable()
export class GoogleAnalyticsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  insertOAuthState(row: { state: string; user_id: string }) {
    return this.supabaseService.getClient().from('google_analytics_oauth_state').insert(row)
  }

  findOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('google_analytics_oauth_state')
      .select('*')
      .eq('state', state)
      .maybeSingle()
  }

  deleteOAuthStateByState(state: string) {
    return this.supabaseService
      .getClient()
      .from('google_analytics_oauth_state')
      .delete()
      .eq('state', state)
  }

  insert(row: {
    connection_id: string
    access_token: string
    refresh_token: string
    token_expiry: string
    property_id: string | null
    property_name: string | null
  }) {
    return this.supabaseService.getClient().from('connections_google_analytics').insert(row)
  }

  findWithUserJoin(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .select('access_token, refresh_token, token_expiry, connections!inner(user_id)')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  updateTokens(
    connectionId: string,
    row: { access_token: string; token_expiry: string },
  ) {
    return this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .update(row)
      .eq('connection_id', connectionId)
  }

  findPropertyId(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .select('property_id')
      .eq('connection_id', connectionId)
      .maybeSingle()
  }

  updateProperty(connectionId: string, propertyId: string, propertyName: string) {
    return this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .update({ property_id: propertyId, property_name: propertyName })
      .eq('connection_id', connectionId)
  }
}
