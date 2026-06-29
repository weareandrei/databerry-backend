import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

@Injectable()
export class PosthogRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByConnectionIdWithUser(connectionId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_posthog')
      .select('api_key, project_id, host, connections!inner(user_id)')
      .eq('connection_id', connectionId)
      .single()
  }
}
