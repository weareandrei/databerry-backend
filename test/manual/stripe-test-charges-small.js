#!/usr/bin/env node
/**
 * Lighter seed variant — same machinery as `stripe-test-charges.js`,
 * about 2x less data:
 *   - 4 customers (vs 8) with new names so they don't collide with
 *     the previous batch
 *   - 9 plan steps (vs 25)
 *   - Spread over 21 days (vs 30)
 *   - 2 active subscriptions (vs 5)
 *
 * Use it to top up an already-seeded account with additional activity
 * (different customers, different days) without doubling the volume.
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

const DAYS_BACK = 21

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

// Distinct from the original 8 (Alice/Bob/…) so the dedupe script can
// tell the two batches apart — these emails are unique to this run.
const CUSTOMERS = [
  { name: 'Nora Dragomir',     email: 'nora@test.example' },
  { name: 'Pavel Ionescu',     email: 'pavel@test.example' },
  { name: 'Yuki Tanaka',       email: 'yuki@test.example' },
  { name: 'Lucas Marchetti',   email: 'lucas@test.example' },
]

/**
 * Plan summary:
 *   - Nora: subscribed early, two one-time buys (one of each price)
 *   - Pavel: one-time only, no sub
 *   - Yuki: subscribed mid-month, one one-time buy
 *   - Lucas: two one-time buys, no sub
 *
 * → 2 active subs (Nora, Yuki) → +30 RON MRR on top of whatever's there
 * → 7 one-time charges spread over the 21-day window
 */
const PLAN = [
  // Nora — early subscriber + mixed buys
  { day: 3,  who: 0, action: 'subscribe' },
  { day: 8,  who: 0, action: 'buy41' },
  { day: 16, who: 0, action: 'buy25' },
  // Pavel — one-time only
  { day: 5,  who: 1, action: 'buy25' },
  { day: 14, who: 1, action: 'buy41' },
  // Yuki — sub + one buy
  { day: 9,  who: 2, action: 'subscribe' },
  { day: 18, who: 2, action: 'buy25' },
  // Lucas — couple of one-time buys
  { day: 6,  who: 3, action: 'buy41' },
  { day: 20, who: 3, action: 'buy25' },
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
