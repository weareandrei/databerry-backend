import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import Stripe from 'stripe';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async handlePosthogEvent(
    connectionId: string,
    viewId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventName = payload.event as string | undefined;

    this.logger.log(
      `\n  ► handlePosthogEvent\n  connectionId : ${connectionId}\n  viewId       : ${viewId}\n  event        : ${eventName ?? '(none)'}`,
    );

    const client = this.supabaseService.getClient();

    // Fetch the view to check its type
    const { data: view, error: viewError } = await client
      .from('views')
      .select('type')
      .eq('id', viewId)
      .single();

    if (viewError || !view) {
      this.logger.warn(`  ⚠ View not found — skipping\n  viewId : ${viewId}`);
      return;
    }

    const viewType = (view.type as string) ?? 'daily_counter';
    this.logger.log(`  → view type : ${viewType}`);

    if (viewType === 'daily_counter') {
      await this.incrementDailyCounter(viewId, client);
    } else {
      this.logger.warn(`  ⚠ Unknown view type "${viewType}" — skipping`);
    }
  }

  // ── Stripe ──────────────────────────────────────────────────────────────

  async handleStripeEvent(rawBody: Buffer, sig: string): Promise<void> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      this.logger.error('  ✗ STRIPE_WEBHOOK_SECRET not set — skipping');
      return;
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      this.logger.error(`  ✗ Stripe signature verification failed\n  ${String(err)}`);
      throw new Error('Invalid Stripe signature');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  💳 Stripe webhook received');
    console.log(`  type    : ${event.type}`);
    console.log(`  account : ${event.account ?? '(platform)'}`);
    console.log('  payload :', JSON.stringify(event.data.object, null, 4));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (event.type !== 'payment_intent.succeeded') return;

    const stripeAccountId = event.account;
    if (!stripeAccountId) {
      this.logger.warn('  ⚠ No account field — not a Connect event, skipping');
      return;
    }

    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const amountCents = paymentIntent.amount;

    const client = this.supabaseService.getClient();

    // Find connection by stripe_account_id
    const { data: stripeConn, error: connError } = await client
      .from('connections_stripe')
      .select('connection_id')
      .eq('stripe_account_id', stripeAccountId)
      .maybeSingle();

    if (connError || !stripeConn) {
      this.logger.warn(`  ⚠ No connection found for stripe_account_id: ${stripeAccountId}`);
      return;
    }

    // Find daily_revenue views for this connection
    const { data: views, error: viewsError } = await client
      .from('views')
      .select('id')
      .eq('connection_id', stripeConn.connection_id)
      .eq('type', 'daily_revenue');

    if (viewsError || !views || views.length === 0) {
      this.logger.log('  → No daily_revenue views found for this connection');
      return;
    }

    this.logger.log(`  → matched ${views.length} daily_revenue view(s), amount: ${amountCents} cents`);

    for (const view of views as { id: string }[]) {
      await this.addToDailyRevenue(view.id, amountCents, client);
    }
  }

  private async addToDailyRevenue(
    viewId: string,
    amountCents: number,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing } = await client
      .from('views_values')
      .select('id, value')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle();

    if (existing) {
      const newValue = (parseInt(existing.value as string, 10) || 0) + amountCents;
      const { error } = await client
        .from('views_values')
        .update({ value: String(newValue), updated_at: new Date().toISOString() })
        .eq('id', existing.id);

      if (error) {
        this.logger.error(`  ✗ Failed to update daily_revenue\n  ${error.message}`);
        return;
      }
      this.logger.log(`  ✓ daily_revenue updated → ${newValue} cents`);
    } else {
      const { error } = await client
        .from('views_values')
        .insert({ view_id: viewId, value: String(amountCents), created_at: today });

      if (error) {
        this.logger.error(`  ✗ Failed to create daily_revenue\n  ${error.message}`);
        return;
      }
      this.logger.log(`  ✓ daily_revenue created → ${amountCents} cents`);
    }
  }

  // ── Custom Webhook ───────────────────────────────────────────────────────

  async handleCustomWebhook(
    webhookId: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabaseService.getClient();

    // 1. Look up connection by webhook_id
    const { data: webhookRow, error: webhookError } = await client
      .from('connections_webhook')
      .select('connection_id')
      .eq('webhook_id', webhookId)
      .maybeSingle();

    if (webhookError || !webhookRow) {
      this.logger.warn(`  ⚠ No webhook connection found for webhookId: ${webhookId}`);
      throw new UnauthorizedException('Invalid webhook');
    }

    const connectionId = webhookRow.connection_id as string;

    // 2. Verify API key
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const { data: keyRow } = await client
      .from('connections_webhook_keys')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (!keyRow) {
      this.logger.warn(`  ⚠ Invalid or revoked API key for connection: ${connectionId}`);
      throw new UnauthorizedException('Invalid API key');
    }

    // 3. Get all views for this connection
    const { data: views } = await client
      .from('views')
      .select('id, type, config')
      .eq('connection_id', connectionId);

    if (!views || views.length === 0) {
      this.logger.log(`  → No views found for custom webhook connection: ${connectionId}`);
      return;
    }

    this.logger.log(
      `\n  ► handleCustomWebhook\n  webhookId    : ${webhookId}\n  connectionId : ${connectionId}\n  views        : ${views.length}`,
    );

    for (const view of views as { id: string; type: string; config: Record<string, unknown> }[]) {
      if (view.type === 'webhook_counter') {
        await this.incrementDailyCounter(view.id, client);
      } else if (view.type === 'webhook_gauge') {
        const field = (view.config?.field as string) ?? 'value';
        const raw = body[field];
        if (raw == null) {
          this.logger.warn(`  ⚠ Field "${field}" not found in body — skipping gauge view ${view.id}`);
          continue;
        }
        await this.storeGaugeValue(view.id, String(raw), client);
      } else if (view.type === 'webhook_append') {
        const field = (view.config?.field as string) ?? 'value';
        const raw = body[field];
        if (raw == null) {
          this.logger.warn(`  ⚠ Field "${field}" not found in body — skipping append view ${view.id}`);
          continue;
        }
        await this.appendValue(view.id, String(raw), client);
      }
    }
  }

  private async storeGaugeValue(
    viewId: string,
    value: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing } = await client
      .from('views_values')
      .select('id')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle();

    if (existing) {
      await client
        .from('views_values')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      this.logger.log(`  ✓ gauge updated → ${value}`);
    } else {
      await client
        .from('views_values')
        .insert({ view_id: viewId, value, created_at: today });
      this.logger.log(`  ✓ gauge created → ${value}`);
    }
  }

  private async appendValue(
    viewId: string,
    value: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    await client
      .from('views_values')
      .insert({ view_id: viewId, value, created_at: today });
    this.logger.log(`  ✓ appended → ${value}`);
  }

  // ── PostHog ──────────────────────────────────────────────────────────────

  private async incrementDailyCounter(
    viewId: string,
    client: ReturnType<SupabaseService['getClient']>,
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const { data: existing } = await client
      .from('views_values')
      .select('id, value')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle();

    if (existing) {
      const newValue = (parseInt(existing.value as string, 10) || 0) + 1;
      const { error } = await client
        .from('views_values')
        .update({ value: String(newValue), updated_at: new Date().toISOString() })
        .eq('id', existing.id);

      if (error) {
        this.logger.error(`  ✗ Failed to update daily counter\n  ${error.message}`);
        return;
      }
      this.logger.log(`  ✓ daily counter updated → ${newValue}`);
    } else {
      const { error } = await client
        .from('views_values')
        .insert({ view_id: viewId, value: '1', created_at: today });

      if (error) {
        this.logger.error(`  ✗ Failed to create daily counter\n  ${error.message}`);
        return;
      }
      this.logger.log(`  ✓ daily counter created → 1`);
    }
  }
}
