import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { ConnectionsRepository } from '../../connections/connections.repository'
import { StripeRepository } from '../stripe.repository'
import { ensureSyncedThrough, type StripeSyncRepos } from './ensure-synced.helper'

const RECONCILE_WINDOW_HOURS = 7 * 24

@Injectable()
export class StripeReconcileService {
  private readonly logger = new Logger(StripeReconcileService.name)

  constructor(
    private readonly stripeRepository: StripeRepository,
    private readonly connectionsRepository: ConnectionsRepository,
  ) {}

  private syncRepos(): StripeSyncRepos {
    return {
      stripe: this.stripeRepository,
      connections: this.connectionsRepository,
    }
  }

  /** Cron: 02:00 UTC daily — well past the 30-min view-sync sweep. */
  @Cron('0 0 2 * * *')
  async reconcileAllAccounts(): Promise<void> {
    const { data: accounts, error } =
      await this.stripeRepository.listCompleteAccountIds()

    if (error) {
      this.logger.error(`  ✗ failed to list accounts: ${error.message}`)
      return
    }

    if (!accounts || accounts.length === 0) {
      this.logger.log('  → reconcile: no accounts to sweep')
      return
    }

    this.logger.log(
      `\n  ► reconcileAllAccounts  count=${accounts.length}  window=${RECONCILE_WINDOW_HOURS}h`,
    )

    for (const a of accounts) {
      await this.reconcileAccount(a.id as string)
    }
  }

  async reconcileAccount(stripeAccountId: string): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const since = now - RECONCILE_WINDOW_HOURS * 3600

      const result = await ensureSyncedThrough(
        this.syncRepos(),
        stripeAccountId,
        since,
        now,
        {
          includeSubscriptions: true,
          triggeredBy: 'reconcile',
        },
        this.logger,
      )

      this.logger.log(
        `  ✓ reconciled ${stripeAccountId} — ${result.chargeCount} charge(s) over last ${RECONCILE_WINDOW_HOURS}h, ${result.subCount} sub(s)`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`  ✗ reconcile failed for ${stripeAccountId}: ${msg}`)
    }
  }
}
