import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { SupabaseService } from '../supabase/supabase.service'
import { getPosthogCredentials } from '../posthog/connection/credentials'
import { fetchAccountCharges, getConnectionProductFilter, getStripeAccountIdForConnection } from '../stripe/views/storage-queries'

interface PendingRow {
  id: string
  view_id: string
  created_at: string
  views: {
    type: string
    connection_id: string
    config: Record<string, unknown>
    connections: {
      type: string
    }
  }
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  @Cron('0 */30 * * * *')
  async syncPendingViews(): Promise<void> {
    const today = new Date().toISOString().split('T')[0]
    const yesterdayDate = new Date(Date.now() - 86_400_000)
    const yesterday = yesterdayDate.toISOString().split('T')[0]

    this.logger.log(`\n  ► syncPendingViews  dates=[${yesterday}, ${today}]`)

    const client = this.supabaseService.getClient()

    const { data: rows, error } = await client
      .from('views_values')
      .select('id, view_id, created_at, views!inner(type, connection_id, config, connections!inner(type))')
      .eq('needs_sync', true)
      .in('created_at', [today, yesterday])

    if (error) {
      this.logger.error(`  ✗ Failed to query pending rows\n  ${error.message}`)
      return
    }

    if (!rows || rows.length === 0) {
      this.logger.log('  → No rows need sync')
      return
    }

    this.logger.log(`  → Found ${rows.length} row(s) to sync`)

    for (const row of rows as unknown as PendingRow[]) {
      try {
        const value = await this.fetchValue(row)
        const { error: updateErr } = await client
          .from('views_values')
          .update({ value, needs_sync: false, updated_at: new Date().toISOString() })
          .eq('id', row.id)

        if (updateErr) {
          this.logger.error(`  ✗ Failed to write synced value for id=${row.id}\n  ${updateErr.message}`)
        } else {
          this.logger.log(`  ✓ Synced views_values.id=${row.id}  value=${value}`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`  ✗ Sync failed for views_values.id=${row.id}\n  ${msg}`)
        // Leave needs_sync = true — will retry on next scheduler run
      }
    }
  }

  private async fetchValue(row: PendingRow): Promise<string> {
    const connType = row.views.connections.type

    switch (connType) {
      case 'posthog':
        return this.fetchPosthogCount(row)
      case 'stripe_manual':
      case 'stripe':
        return this.fetchStripeRevenue(row)
      default:
        throw new Error(`No sync handler for connection type: ${connType}`)
    }
  }

  private async fetchPosthogCount(row: PendingRow): Promise<string> {
    const connectionId = row.views.connection_id
    const eventName = (row.views.config?.eventName as string | undefined) ?? ''

    if (!eventName) {
      this.logger.warn(`  ⚠ No eventName in view config for view_id=${row.view_id}`)
      return '0'
    }

    const ph = await getPosthogCredentials(connectionId, this.supabaseService)
    if (!ph) throw new Error(`PostHog credentials not found for connection ${connectionId}`)

    // Use row.created_at so yesterday's sync queries the correct date
    const safeEvent = eventName.replace(/'/g, "\\'")
    const hogqlQuery = `SELECT count() FROM events WHERE event = '${safeEvent}' AND toDate(timestamp) = toDate('${row.created_at}')`

    const res = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ph.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogqlQuery } }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`PostHog query API ${res.status}: ${JSON.stringify(body)}`)
    }

    const json = (await res.json()) as { results?: [[number]] }
    return String(json.results?.[0]?.[0] ?? 0)
  }

  private async fetchStripeRevenue(row: PendingRow): Promise<string> {
    // Stripe data lives in Supabase now (see stripe/sync). The "needs_sync"
    // flag for Stripe rows is legacy — webhooks push charges into
    // `stripe_charges` directly, and the nightly reconcile catches gaps.
    // This handler simply reads the same Supabase tables to fill in the
    // tile cache (`views_values.value`) for cross-provider consistency.
    const client = this.supabaseService.getClient()
    const connectionId = row.views.connection_id

    const accountId = await getStripeAccountIdForConnection(client, connectionId)
    if (!accountId) return '0'

    const productFilter = await getConnectionProductFilter(client, connectionId)
    const date = row.created_at
    const charges = await fetchAccountCharges(client, accountId, date, date, productFilter)

    const total = charges.reduce((sum, c) => sum + c.amount, 0)
    return String(total)
  }
}
