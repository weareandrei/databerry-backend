#!/usr/bin/env node
/**
 * Lighter seed variant — same machinery as `stripe-test-charges.js`,
 * about 2x less data:
 *   - 4 customers (vs 8) with new names so they don't collide with
 *     the previous batch
 *   - 9 plan steps (vs 25)
 *   - Spread over ~2-3 weeks
 *   - 2 active subscriptions (vs 5)
 *
 * Use it to top up an already-seeded account with additional activity
 * (different customers, different days) without doubling the volume.
 *
 * When re-running this script:
 *   1. Replace the CUSTOMERS list with fresh names + emails (otherwise
 *      Stripe creates duplicate customer rows — emails are not unique
 *      keys for `customers.create`). The names below are unique to
 *      each batch run; keep that convention.
 *   2. Bump DAYS_BACK so the window spans roughly "last seed → today"
 *      (`node test/manual/check-charge-dates.js` shows the most recent
 *      charge date; subtract from today to size the window).
 *   3. Trim PLAN so no step has `day > DAYS_BACK - 1` — otherwise the
 *      Test Clock would have to advance into the future, which Stripe
 *      doesn't allow.
 *
 * Run from the backend folder:
 *   node test/manual/stripe-test-charges-small.js
 *
 * Secrets, products, and Test Clock chunking work identically to the
 * full seed — see stripe-test-charges.js for the in-depth comments.
 */

const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env.testing'),
})

const Stripe = require('stripe')

const SECRET_KEY = process.env.STRIPE_SECRET_KEY
const CONNECTED_ACCOUNT = process.env.STRIPE_CONNECTED_ACCOUNT

const PRODUCTS = {
  P41: 'prod_UQSgjwsOvdzpk6', // 41 RON one-time
  P25: 'prod_UQSg7cDR95tDlw', // 25 RON one-time
  SUB: 'prod_UQSfxHRqtKUI7l', // 15 RON / month
}

const DAYS_BACK = 16

function fail(msg) {
  console.error(`✗ ${msg}`)
  console.error('  Fill it in at backend/.env.testing')
  process.exit(1)
}

if (!SECRET_KEY) fail('STRIPE_SECRET_KEY is not set')
if (!CONNECTED_ACCOUNT) fail('STRIPE_CONNECTED_ACCOUNT is not set')
if (!SECRET_KEY.startsWith('sk_test_')) {
  fail(
    `Refusing to run with a non-test key (${SECRET_KEY.slice(0, 8)}…). ` +
      'Use a test-mode key.',
  )
}

const stripe = new Stripe(SECRET_KEY, { stripeAccount: CONNECTED_ACCOUNT })

// Distinct from every previous batch (original Alice/Bob/…,
// Nora/Pavel/Yuki/Lucas, Maria/Diego/Aiko/Tomas, Sofia/Hassan/Greta/Kenji,
// Lena/Mateo/Priya/Oskar/Yara, and the last Amara/Felix/Sana/Theo run)
// so the dedupe script can tell each batch apart — emails unique to
// this run.
const CUSTOMERS = [
  { name: 'Indira Rao',        email: 'indira@test.example' },
  { name: 'Mateusz Nowak',     email: 'mateusz@test.example' },
  { name: 'Chen Wei',          email: 'chenwei@test.example' },
  { name: 'Olamide Adebayo',   email: 'olamide@test.example' },
]

/**
 * Plan summary (fits inside DAYS_BACK=16, so no step has day ≥ 16):
 *   - Indira:  subscriber + two one-time buys
 *   - Mateusz: one-time only, three buys (mix of prices)
 *   - Chen:    subscriber + one one-time buy
 *   - Olamide: one-time only, two buys
 *
 * → 2 active subs (Indira, Chen) → +30 RON MRR on top of whatever's there
 * → 8 one-time charges spread over the 16-day window
 */
const PLAN = [
  // Indira — subscriber + mixed buys
  { day: 2,  who: 0, action: 'subscribe' },
  { day: 6,  who: 0, action: 'buy41' },
  { day: 11, who: 0, action: 'buy25' },
  // Mateusz — three one-time buys, no sub
  { day: 1,  who: 1, action: 'buy25' },
  { day: 8,  who: 1, action: 'buy41' },
  { day: 13, who: 1, action: 'buy25' },
  // Chen — sub + one buy
  { day: 4,  who: 2, action: 'subscribe' },
  { day: 12, who: 2, action: 'buy41' },
  // Olamide — two one-time buys
  { day: 5,  who: 3, action: 'buy41' },
  { day: 10, who: 3, action: 'buy25' },
]

async function waitForClockReady(clockId, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === 'ready') return clock
    if (clock.status === 'internal_failure') {
      throw new Error(`Test clock ${clockId} entered internal_failure state`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`Test clock ${clockId} not ready after ${timeoutMs}ms`)
}

async function advanceClockAndWait(clockId, frozenTime) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime })
  await waitForClockReady(clockId)
}

async function activePriceFor(productId) {
  const list = await stripe.prices.list({ product: productId, active: true, limit: 1 })
  if (list.data.length === 0) {
    throw new Error(`No active price found for product ${productId}`)
  }
  return list.data[0].id
}

async function payOneTime(customerId, priceId, label) {
  await stripe.invoiceItems.create({
    customer: customerId,
    pricing: { price: priceId },
  })
  const inv = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    pending_invoice_items_behavior: 'include',
    collection_method: 'charge_automatically',
  })
  await stripe.invoices.finalizeInvoice(inv.id)
  const paid = await stripe.invoices.pay(inv.id)
  return { invoiceId: inv.id, status: paid.status, label }
}

async function subscribe(customerId) {
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: PRICES.SUB }],
  })
}

const PRICES = { P41: null, P25: null, SUB: null }

const MAX_CUSTOMERS_PER_CLOCK = 3

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function runClock({ chunkIndex, customerProfiles, customerOffset, startUnix, dateLabel }) {
  console.log(
    `\n══ clock #${chunkIndex + 1}: ${customerProfiles.map(c => c.name).join(', ')} ══`,
  )

  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: startUnix,
    name: `seed-small-${dateLabel}-${chunkIndex + 1}`,
  })
  console.log(`  test clock ${clock.id} frozen at ${new Date(startUnix * 1000).toISOString()}`)

  const customerIds = []
  for (const profile of customerProfiles) {
    const cus = await stripe.customers.create({
      name: profile.name,
      email: profile.email,
      test_clock: clock.id,
    })
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: cus.id })
    await stripe.customers.update(cus.id, {
      invoice_settings: { default_payment_method: pm.id },
    })
    customerIds.push(cus.id)
    console.log(`    customer ${cus.id}  ${profile.name}`)
  }

  const localPlan = PLAN
    .filter(step => {
      const local = step.who - customerOffset
      return local >= 0 && local < customerProfiles.length
    })
    .map(step => ({ ...step, localWho: step.who - customerOffset }))
    .sort((a, b) => a.day - b.day)

  let currentDay = 0
  for (const step of localPlan) {
    if (step.day > currentDay) {
      const newFrozen = startUnix + step.day * 86_400
      await advanceClockAndWait(clock.id, newFrozen)
      currentDay = step.day
      console.log(
        `  day ${currentDay} (${new Date(newFrozen * 1000).toISOString().slice(0, 10)}):`,
      )
    }

    const cus = customerIds[step.localWho]
    const name = customerProfiles[step.localWho].name

    if (step.action === 'subscribe') {
      const sub = await subscribe(cus)
      console.log(`    ${name}: subscribed (${sub.id}) status=${sub.status}`)
    } else {
      const priceId = step.action === 'buy41' ? PRICES.P41 : PRICES.P25
      const label = step.action === 'buy41' ? '41 RON' : '25 RON'
      const result = await payOneTime(cus, priceId, label)
      console.log(`    ${name}: ${label} ${result.invoiceId} → ${result.status}`)
    }
  }

  const finalUnix = Math.floor(Date.now() / 1000)
  await advanceClockAndWait(clock.id, finalUnix)
  console.log(`  → advanced to now`)

  return clock.id
}

async function main() {
  console.log('Looking up active prices…')
  PRICES.P41 = await activePriceFor(PRODUCTS.P41)
  PRICES.P25 = await activePriceFor(PRODUCTS.P25)
  PRICES.SUB = await activePriceFor(PRODUCTS.SUB)
  console.log(`  41 RON     → ${PRICES.P41}`)
  console.log(`  25 RON     → ${PRICES.P25}`)
  console.log(`  15/mo sub  → ${PRICES.SUB}`)

  const startUnix = Math.floor(Date.now() / 1000) - DAYS_BACK * 86_400
  const dateLabel = new Date(startUnix * 1000).toISOString().slice(0, 10)

  const chunks = chunk(CUSTOMERS, MAX_CUSTOMERS_PER_CLOCK)
  console.log(
    `\nSeeding ${CUSTOMERS.length} customers across ${chunks.length} test clocks ` +
      `(Stripe caps at ${MAX_CUSTOMERS_PER_CLOCK} customers per clock).`,
  )

  const clockIds = []
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    const id = await runClock({
      chunkIndex: i,
      customerProfiles: chunks[i],
      customerOffset: offset,
      startUnix,
      dateLabel,
    })
    clockIds.push(id)
    offset += chunks[i].length
  }

  console.log('\nDone.')
  console.log(`  Clocks: ${clockIds.join(', ')}`)
  console.log('  Charges land in stripe_charges via webhook (or via "Refresh data from Stripe").')
  console.log(
    '\n  To clean up: Stripe Dashboard → Developers → Test clocks → delete each.',
  )
}

main().catch(err => {
  console.error('\n✗ seed failed:', err.message)
  if (err.raw) console.error('  raw:', err.raw)
  process.exit(1)
})
