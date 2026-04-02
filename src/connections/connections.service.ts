import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PosthogService } from '../posthog/posthog.service';

export interface CreateConnectionDto {
  name: string;
  type: string;
  config?: Record<string, unknown>; // type-specific credentials (e.g. apiKey, projectId)
}

export interface UpdateConnectionDto {
  name?: string;
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly posthogService: PosthogService,
  ) {}

  async getConnections(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return data.map(this.toCamel);
  }

  async getConnectionById(connectionId: string, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('*')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Connection not found');
    return this.toCamel(data);
  }

  async createConnection(dto: CreateConnectionDto, userId: string) {
    const client = this.supabaseService.getClient();

    // 1. Insert base connection record
    const { data, error } = await client
      .from('connections')
      .insert({ name: dto.name, type: dto.type, user_id: userId })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // 2. Insert type-specific config table
    if (dto.config) {
      await this.insertTypeConfig(dto.type, data.id, dto.config, client);
    }

    return this.toCamel(data);
  }

  async updateConnection(connectionId: string, dto: UpdateConnectionDto, userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .update({ name: dto.name })
      .eq('id', connectionId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Connection not found');
    return this.toCamel(data);
  }

  async deleteConnection(connectionId: string, userId: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('connections')
      .delete()
      .eq('id', connectionId)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);
  }

  async getPosthogEventDefinitions(connectionId: string, userId: string) {
    return this.posthogService.getEventDefinitions(connectionId, userId);
  }

  private async insertTypeConfig(
    type: string,
    connectionId: string,
    config: Record<string, unknown>,
    client: ReturnType<SupabaseService['getClient']>,
  ) {
    if (type === 'posthog') {
      const { error } = await client.from('connections_posthog').insert({
        connection_id: connectionId,
        api_key: config.apiKey,
        project_id: config.projectId,
        host: config.host ?? 'https://app.posthog.com',
      });
      if (error) throw new Error(error.message);
    }
    // Future: stripe, sentry, github, etc.
  }

  private toCamel(row: Record<string, unknown>) {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      userId: row.user_id,
      createdAt: row.created_at,
    };
  }
}
