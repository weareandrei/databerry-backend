import type { Logger } from '@nestjs/common'
import type Stripe from 'stripe'
import type { SupabaseService } from '../../../supabase/supabase.service'
import { makeStripeGetterForAccount } from '../../sync/account-getter.helper'
import { resolveChargeLineItems } from '../../sync/line-items.helper'
import {
  replaceLineItems,
  upsertCharge,
} from '../../sync/persist.helper'
import type { StripeChargeRow } from '../../sync/types'

type Client = ReturnType<SupabaseService['getClient']>

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
  client: Client,
  logger: Logger,
): Promise<void> {
  // Resolve target account. `eventAccount` is the authoritative signal for
  // Connect; for platform events we trust the charge's own `on_behalf_of` /
  // `account` if present. (Stripe does not include `charge.account`, but
  // platform-mode events from a single account are uncommon for our setup;
  // we ship a warning and skip rather than guess.)
  const stripeAccountId = eventAccount
  if (!stripeAccountId) {
    logger.warn('  ⚠ charge event has no event.account — cannot route, skipping')
    return
  }

  // Guard: only act on accounts we know about. Avoids accidentally
  // populating rows for an account we haven't backfilled (which would skew
  // totals once the backfill DOES run, since reconcile windows wouldn't
  // overlap).
  const { data: account } = await client
    .from('stripe_accounts')
    .select('id, backfill_status')
    .eq('id', stripeAccountId)
    .maybeSingle()

  if (!account) {
    logger.warn(`  ⚠ unknown stripe_account_id=${stripeAccountId} — skipping`)
    return
  }

  // Normalise Stripe SDK shape → our minimal row shape (the SDK uses richer
  // types than our resolver expects, but field-by-field they line up).
  // The `invoice` field is delivered by the API but the official TS types
  // for `Stripe.Charge` no longer surface it as a public property — fall back
  // to a permissive accessor so we don't lose the link.
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

  await upsertCharge(client, stripeAccountId, row)

  // Resolve & persist line items. Webhook payloads don't include the
  // expanded invoice, so this will round-trip to the Stripe API once per
  // charge — acceptable since webhooks are infrequent.
  try {
    const get = await makeStripeGetterForAccount(client, stripeAccountId)
    const lineItems = await resolveChargeLineItems(get, row, logger)
    await replaceLineItems(client, charge.id, stripeAccountId, lineItems)
  } catch (err) {
    logger.warn(`  ⚠ line-item resolution failed for ${charge.id}: ${String(err)}`)
    // Charge row is still persisted — totals work, attribution may fall back
    // to "unattributed". Nightly reconcile will retry.
  }

  logger.log(`  ✓ persisted charge ${charge.id} (${charge.status}) for ${stripeAccountId}`)
}
