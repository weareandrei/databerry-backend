import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { SupabaseService } from '../supabase/supabase.service'
import { ConnectionsRepository } from '../connections/connections.repository'
import { StripeRepository } from '../stripe/stripe.repository'
import { ViewsRepository } from '../views/views.repository'
import { PosthogCredentialsService } from '../posthog/connection/credentials'
import { PosthogApiClient } from '../posthog/posthog-api.client'
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

  constructor(
    private readonly viewsRepository: ViewsRepository,
    private readonly posthogCredentialsService: PosthogCredentialsService,
    private readonly supabaseService: SupabaseService,
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly stripeRepository: StripeRepository,
  ) {}

  @Cron('0 */30 * * * *')
  async syncPendingViews(): Promise<void> {
    const today = new Date().toISOString().split('T')[0]
    const yesterdayDate = new Date(Date.now() - 86_400_000)
    const yesterday = yesterdayDate.toISOString().split('T')[0]

    this.logger.log(`\n  ► syncPendingViews  dates=[${yesterday}, ${today}]`)

    const { data: rows, error } = await this.viewsRepository.findPendingSyncRows([
      today,
      yesterday,
    ])

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
        const { error: updateErr } = await this.viewsRepository.markValueSynced(row.id, value)

        if (updateErr) {
          this.logger.error(`  ✗ Failed to write synced value for id=${row.id}\n  ${updateErr.message}`)
        } else {
          this.logger.log(`  ✓ Synced views_values.id=${row.id}  value=${value}`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`  ✗ Sync failed for views_values.id=${row.id}\n  ${msg}`)
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

    const ph = await this.posthogCredentialsService.getCredentials(connectionId)
    if (!ph) throw new Error(`PostHog credentials not found for connection ${connectionId}`)

    const client = new PosthogApiClient(ph)
    const safeEvent = eventName.replace(/'/g, "\\'")
    const hogqlQuery = `SELECT count() FROM events WHERE event = '${safeEvent}' AND toDate(timestamp) = toDate('${row.created_at}')`

    try {
      const json = (await client.queryHogql(hogqlQuery)) as { results?: [[number]] }
      return String(json.results?.[0]?.[0] ?? 0)
    } catch (err) {
      throw new Error(`PostHog query API: ${String(err)}`)
    }
  }

  private async fetchStripeRevenue(row: PendingRow): Promise<string> {
    const connectionId = row.views.connection_id

    const accountId = await getStripeAccountIdForConnection(
      this.connectionsRepository,
      connectionId,
    )
    if (!accountId) return '0'

    const productFilter = await getConnectionProductFilter(
      this.connectionsRepository,
      connectionId,
    )
    const date = row.created_at
    const charges = await fetchAccountCharges(
      this.stripeRepository,
      accountId,
      date,
      date,
      productFilter,
    )

    const total = charges.reduce((sum, c) => sum + c.amount, 0)
    return String(total)
  }
}
