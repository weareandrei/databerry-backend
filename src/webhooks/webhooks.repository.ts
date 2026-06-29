import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class WebhooksRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByWebhookId(webhookId: string) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook')
      .select('connection_id')
      .eq('webhook_id', webhookId)
      .maybeSingle()
  }

  async findValidKey(connectionId: string, keyHash: string) {
    return this.supabaseService
      .getClient()
      .from('connections_webhook_keys')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle()
  }
}
