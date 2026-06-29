import type { Logger } from '@nestjs/common'
import type Stripe from 'stripe'
import type { ConnectionsRepository } from '../../../connections/connections.repository'
import type { StripeRepository } from '../../stripe.repository'
import { createStripeApiClientForAccount } from '../../sync/account-getter.helper'
import { resolveChargeLineItems } from '../../sync/line-items.helper'
import {
  replaceLineItems,
  upsertCharge,
} from '../../sync/persist.helper'
import type { StripeChargeRow } from '../../sync/types'

export interface ChargeEventRepos {
  stripe: StripeRepository
  connections: ConnectionsRepository
}

/**
 * Handle a `charge.*` webhook event by upserting the charge row and
 * (re-)resolving its line items. Idempotent — replays of the same event
 * produce the same end state.
 *
 * Account resolution:
 *   - For Connect events, `event.account` carries the connected acct_xxx.
 *     Match it directly against `stripe_accounts.id`.
 *   - For platform-mode events (no `event.account`), fall back to looking up
 *     the account by the charge's `account` field (rare path: only happens
 *     when the webhook is configured against a manual API key whose webhook
 *     endpoint is set on the user's own Stripe dashboard).
 */
export async function handleChargeEvent(
  charge: Stripe.Charge,
  eventAccount: string | null,
  repos: ChargeEventRepos,
  logger: Logger,
): Promise<void> {
  const stripeAccountId = eventAccount
  if (!stripeAccountId) {
    logger.warn('  ⚠ charge event has no event.account — cannot route, skipping')
    return
  }

  const { data: account } = await repos.stripe.findIdAndBackfillStatus(stripeAccountId)

  if (!account) {
    logger.warn(`  ⚠ unknown stripe_account_id=${stripeAccountId} — skipping`)
    return
  }

  const chargeAny = charge as unknown as {
    invoice?: string | { id: string } | null
  }
  const row: StripeChargeRow = {
    id: charge.id,
    amount: charge.amount,
    amount_refunded: charge.amount_refunded,
    currency: charge.currency,
    status: charge.status,
    created: charge.created,
    payment_intent:
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null,
    invoice:
      typeof chargeAny.invoice === 'string'
        ? chargeAny.invoice
        : chargeAny.invoice?.id ?? null,
    customer:
      typeof charge.customer === 'string'
        ? charge.customer
        : charge.customer?.id ?? null,
  }

  await upsertCharge(repos.stripe, stripeAccountId, row)

  try {
    const client = await createStripeApiClientForAccount(repos.connections, stripeAccountId)
    const lineItems = await resolveChargeLineItems(client, row, logger)
    await replaceLineItems(repos.stripe, charge.id, stripeAccountId, lineItems)
  } catch (err) {
    logger.warn(`  ⚠ line-item resolution failed for ${charge.id}: ${String(err)}`)
  }

  logger.log(`  ✓ persisted charge ${charge.id} (${charge.status}) for ${stripeAccountId}`)
}
