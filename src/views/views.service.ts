import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PosthogService } from '../posthog/posthog.service';

export interface CreateViewDto {
  folderId: string;
  connectionId: string;
  connectionType: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
}

@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly posthogService: PosthogService,
  ) {}

  async getViewsByFolder(folderId: string, userId: string, date?: string) {
    this.logger.log(
      `\n  ► getViewsByFolder\n  folderId : ${folderId}\n  userId   : ${userId}\n  date     : ${date ?? 'today (latest)'}`,
    );

    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .select('*, views_values(value, created_at)')
      .eq('folder_id', folderId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return data.map((row) => this.toCamel(row, date));
  }

  async createView(dto: CreateViewDto, userId: string) {
    this.logger.log(
      `\n  ► createView\n  folderId       : ${dto.folderId}\n  connectionId   : ${dto.connectionId}\n  connectionType : ${dto.connectionType}\n  name           : ${dto.name}`,
    );

    // For PostHog views: create Hog Function first — if it fails, abort
    let hogFunctionId: string | null = null;
    if (dto.connectionType === 'posthog') {
      const eventName = (dto.config?.eventName as string) ?? dto.name;

      // We need a placeholder viewId for the webhook URL — we'll use a temp UUID
      // and update it after the view is created. Instead, create view first with
      // a two-step approach: reserve the row, register, then confirm.
      // Simplest: create view, register Hog Function, rollback view if it fails.
      const { data: tempView, error: tempError } = await this.supabaseService
        .getClient()
        .from('views')
        .insert({
          folder_id: dto.folderId,
          connection_id: dto.connectionId,
          connection_type: dto.connectionType,
          type: dto.type,
          name: dto.name,
          config: dto.config ?? {},
          is_pinned: false,
          user_id: userId,
        })
        .select()
        .single();

      if (tempError) {
        this.logger.error(`  ✗ createView failed\n  ${tempError.message}`);
        throw new Error(tempError.message);
      }

      hogFunctionId = await this.posthogService.createHogFunction(
        dto.connectionId,
        tempView.id as string,
        eventName,
      );

      if (!hogFunctionId) {
        // Roll back the view
        await this.supabaseService
          .getClient()
          .from('views')
          .delete()
          .eq('id', tempView.id);
        this.logger.error(`  ✗ Hog Function creation failed — view rolled back`);
        throw new Error('Failed to register PostHog destination. Check your API key has the hog_function:write scope.');
      }

      // Store hogFunctionId in config
      await this.supabaseService
        .getClient()
        .from('views')
        .update({ config: { ...(dto.config ?? {}), hogFunctionId } })
        .eq('id', tempView.id);

      this.logger.log(`  ✓ view created and hog function registered  id: ${tempView.id}`);
      return this.toCamel({ ...tempView, config: { ...(dto.config ?? {}), hogFunctionId } });
    }

    // Non-PostHog views — just create directly
    const { data, error } = await this.supabaseService
      .getClient()
      .from('views')
      .insert({
        folder_id: dto.folderId,
        connection_id: dto.connectionId,
        connection_type: dto.connectionType,
        type: dto.type,
        name: dto.name,
        config: dto.config ?? {},
        is_pinned: false,
        user_id: userId,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`  ✗ createView failed\n  ${error.message}`);
      throw new Error(error.message);
    }

    this.logger.log(`  ✓ view created  id: ${data.id}`);
    return this.toCamel(data);
  }

  async deleteView(viewId: string, userId: string) {
    this.logger.log(
      `\n  ► deleteView\n  viewId : ${viewId}\n  userId : ${userId}`,
    );

    // Fetch view first to get hogFunctionId from config before deleting
    const { data: view } = await this.supabaseService
      .getClient()
      .from('views')
      .select('connection_id, connection_type, config')
      .eq('id', viewId)
      .eq('user_id', userId)
      .single();

    const { error } = await this.supabaseService
      .getClient()
      .from('views')
      .delete()
      .eq('id', viewId)
      .eq('user_id', userId);

    if (error) {
      this.logger.error(`  ✗ deleteView failed\n  ${error.message}`);
      throw new NotFoundException('View not found');
    }

    this.logger.log(`  ✓ view deleted`);

    // Clean up Hog Function in PostHog (non-blocking)
    if (
      view?.connection_type === 'posthog' &&
      view?.connection_id &&
      (view.config as Record<string, unknown>)?.hogFunctionId
    ) {
      const hogFunctionId = (view.config as Record<string, unknown>)
        .hogFunctionId as string;

      this.posthogService
        .deleteHogFunction(view.connection_id as string, hogFunctionId)
        .catch((err) => {
          this.logger.error(
            `  ✗ deleteHogFunction failed silently\n  ${err.message}`,
          );
        });
    }
  }

  private toCamel(row: Record<string, unknown>, date?: string) {
    const values = (row.views_values as { value: string; created_at: string }[] | null) ?? [];
    const viewType = (row.type as string) ?? 'daily_counter';

    let displayValue: string | null = null;

    if (viewType === 'webhook_append') {
      // Count entries for the target date (today if no date specified)
      const targetDate = date ?? new Date().toISOString().split('T')[0];
      const count = values.filter((v) => v.created_at === targetDate).length;
      displayValue = count > 0 ? String(count) : null;
    } else if (date) {
      // Historical: exact date match
      const match = values.find((v) => v.created_at === date);
      displayValue = match?.value ?? null;
    } else {
      // Today: latest value by date
      const sorted = [...values].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      displayValue = sorted[0]?.value ?? null;
    }

    return {
      id: row.id,
      folderId: row.folder_id,
      connectionId: row.connection_id,
      connectionType: row.connection_type,
      type: viewType,
      name: row.name,
      config: row.config ?? {},
      value: displayValue,
      isPinned: row.is_pinned ?? false,
      userId: row.user_id,
      createdAt: row.created_at,
    };
  }
}
