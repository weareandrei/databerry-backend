#!/usr/bin/env node
/**
 * Seeds a Stripe Connect test account with realistic activity spread
 * across the past 30 days using Stripe Test Clocks.
 *
 * Run from the backend folder:
 *   node test/manual/stripe-test-charges.js
 *
 * Secrets (loaded from backend/.env.testing — see
 * backend/.env.testing.example for the shape):
 *   STRIPE_SECRET_KEY              — must be sk_test_…
 *   STRIPE_CONNECTED_ACCOUNT       — acct_…
 *
 * Everything else (product IDs, day-window, customer plan) is
 * hardcoded below — those aren't secrets and they should be
 * versioned with the code so the seed scenario stays reproducible.
 *
 * What it produces:
 *   - 1 test clock frozen at 30 days ago
 *   - 8 customers (with names + emails) all bound to that clock
 *   - ~25 paid invoices for the two one-time products
 *   - 5 active subscriptions on the monthly product
 *   - All events with backdated `created` timestamps
 *
 * Cleanup: delete the test clock from the Stripe Dashboard
 *   (Developers → Test clocks). That cascades all attached customers,
 *   subscriptions, invoices, and charges in one click.
 */

const path = require('path')
// Resolve relative to this file so the script works regardless of CWD
// (you can `node test/manual/...` from backend/, or `node backend/...`
// from the repo root, either way `.env.testing` is found).
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env.testing'),
})

const Stripe = require('stripe')

// ─── Secrets (env-loaded) ──────────────────────────────────────────────────

const SECRET_KEY = process.env.STRIPE_SECRET_KEY
const CONNECTED_ACCOUNT = process.env.STRIPE_CONNECTED_ACCOUNT

// ─── Hardcoded scenario config ─────────────────────────────────────────────
// Not secrets. Versioned with the script so the seed scenario stays
// reproducible across machines. Edit here if you want to seed against
// different products or change the time window.

const PRODUCTS = {
  P41: 'prod_UQSgjwsOvdzpk6', // 41 RON one-time
  P25: 'prod_UQSg7cDR95tDlw', // 25 RON one-time
  SUB: 'prod_UQSfxHRqtKUI7l', // 15 RON / month
}

const DAYS_BACK = 30

// ─── Validate secrets ──────────────────────────────────────────────────────

function fail(msg) {
  console.error(`✗ ${msg}`)
  console.error('  Fill it in at backend/.env.testing')
  console.error('  (template at backend/.env.testing.example)')
  process.exit(1)
}

if (!SECRET_KEY) fail('STRIPE_SECRET_KEY is not set')
if (!CONNECTED_ACCOUNT) fail('STRIPE_CONNECTED_ACCOUNT is not set')
// Safety belt: refuse to run with a live key. This script creates
// 25+ invoices and 5 subscriptions — running on a real account would
// be very bad.
if (!SECRET_KEY.startsWith('sk_test_')) {
  fail(
    `Refusing to run with a non-test key (${SECRET_KEY.slice(0, 8)}…). ` +
      'Use a test-mode key.',
  )
}

// SDK is configured once with the connected account; every call below
// is automatically scoped to it (equivalent to `Stripe-Account` header).
const stripe = new Stripe(SECRET_KEY, { stripeAccount: CONNECTED_ACCOUNT })

const CUSTOMERS = [
  { name: 'Alice Johnson',   email: 'alice@test.example' },
  { name: 'Bob Martinez',    email: 'bob@test.example' },
  { name: 'Carla Schmidt',   email: 'carla@test.example' },
  { name: 'Diego Pereira',   email: 'diego@test.example' },
  { name: 'Emma Thompson',   email: 'emma@test.example' },
  { name: 'Felipe Costa',    email: 'felipe@test.example' },
  { name: 'Grace Wong',      email: 'grace@test.example' },
  { name: 'Hassan Ali',      email: 'hassan@test.example' },
]

/**
 * Per-step plan — each entry happens on the given day-offset (0 = clock
 * start, i.e. 30 days ago; 30 = today). Sorted by day so we advance the
 * clock linearly, never backwards.
 *
 * Designed so:
 *   - 5 active subs at varying start dates → MRR = 75 RON regardless of
 *     when you check, top-customer ordering is stable
 *   - Charges spread across the month so the daily/weekly chart isn't a
 *     single spike
 *   - Each customer touches different products so the per-product filter
 *     has variety
 */
const PLAN = [
  // Alice — heavy spender, subscribed early
  { day: 2,  who: 0, action: 'subscribe' },
  { day: 5,  who: 0, action: 'buy41' },
  { day: 12, who: 0, action: 'buy41' },
  { day: 22, who: 0, action: 'buy41' },
  // Bob — mixed one-time, no sub
  { day: 7,  who: 1, action: 'buy41' },
  { day: 7,  who: 1, action: 'buy25' },
  { day: 19, who: 1, action: 'buy41' },
  // Carla — sub only, late signup
  { day: 25, who: 2, action: 'subscribe' },
  // Diego — bulk on small product
  { day: 4,  who: 3, action: 'buy25' },
  { day: 9,  who: 3, action: 'buy25' },
  { day: 14, who: 3, action: 'buy25' },
  { day: 21, who: 3, action: 'buy25' },
  { day: 28, who: 3, action: 'buy25' },
  // Emma — sub + mixed
  { day: 8,  who: 4, action: 'subscribe' },
  { day: 11, who: 4, action: 'buy41' },
  { day: 16, who: 4, action: 'buy25' },
  { day: 24, who: 4, action: 'buy25' },
  // Felipe — single purchase
  { day: 17, who: 5, action: 'buy41' },
  // Grace — sub mid, charges before
  { day: 6,  who: 6, action: 'buy25' },
  { day: 13, who: 6, action: 'buy25' },
  { day: 18, who: 6, action: 'subscribe' },
  { day: 27, who: 6, action: 'buy25' },
  // Hassan — sub, two charges
  { day: 10, who: 7, action: 'subscribe' },
  { day: 15, who: 7, action: 'buy41' },
  { day: 26, who: 7, action: 'buy41' },
]

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * `testClocks.advance()` returns immediately, but the clock is still
 * in `status='advancing'` server-side while it processes all the
 * subscription renewals / scheduled charges that fall in the elapsed
 * period. Any modification (create customer, create invoice, …) made
 * while the clock is advancing fails with a 429 / "advancement
 * underway" error. Poll until `ready` before continuing.
 */
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

/** Advance + wait for ready, in one call. */
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
  // Stripe API ≥ 2025-09 renamed the top-level `price` param on
  // invoiceItems.create to `pricing: { price: … }`. Subscriptions kept
  // the old `items: [{ price }]` shape, so only this call needs the
  // new wrapper.
  await stripe.invoiceItems.create({
    customer: customerId,
    pricing: { price: priceId },
  })
  // `pending_invoice_items_behavior: 'include'` pulls the item we just
  // created onto this invoice. Without it the invoice could be created
  // empty and the item would orphan onto the next one.
  const inv = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    pending_invoice_items_behavior: 'include',
    collection_method: 'charge_automatically',
  })
  await stripe.invoices.finalizeInvoice(inv.id)
  // No explicit `payment_method` — Stripe walks up to
  // customer.invoice_settings.default_payment_method (which we set
  // when the customer was created). The literal `pm_card_visa` test
  // fixture only works on `paymentMethods.attach`; it's not a valid
  // PM ID for use elsewhere.
  const paid = await stripe.invoices.pay(inv.id)
  return { invoiceId: inv.id, status: paid.status, label }
}

async function subscribe(customerId) {
  // Same as payOneTime — relies on customer.invoice_settings.default_payment_method.
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: PRICES.SUB }],
  })
}

// Mutated after price lookup — captured here so helpers above can read it.
const PRICES = { P41: null, P25: null, SUB: null }

/**
 * Stripe enforces a hard cap of 3 customers per test clock. We chunk
 * `CUSTOMERS` accordingly and run one clock per chunk — each chunk is
 * created at the same start time and stepped through the same plan,
 * just for its own subset of customers, so the resulting timeline is
 * indistinguishable from a single-clock run.
 */
const MAX_CUSTOMERS_PER_CLOCK = 3

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ─── Per-clock work ────────────────────────────────────────────────────────

/**
 * Spin up a single test clock, attach `customerProfiles` to it, run the
 * subset of `PLAN` that targets those customers, and advance the clock
 * to "now" so the events land in the present. Returns the clock id so
 * the caller can list all of them at the end (for cleanup convenience).
 */
async function runClock({ chunkIndex, customerProfiles, customerOffset, startUnix, dateLabel }) {
  console.log(
    `\n══ clock #${chunkIndex + 1}: ${customerProfiles.map(c => c.name).join(', ')} ══`,
  )

  // 1. Create the clock.
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: startUnix,
    name: `seed-${dateLabel}-${chunkIndex + 1}`,
  })
  console.log(`  test clock ${clock.id} frozen at ${new Date(startUnix * 1000).toISOString()}`)

  // 2. Create customers + attach a card.
  const customerIds = []
  for (const profile of customerProfiles) {
    const cus = await stripe.customers.create({
      name: profile.name,
      email: profile.email,
      test_clock: clock.id,
    })
    // Attach a unique copy of the test PM and set as default — keeps
    // both subscription billing and invoice.pay happy without further
    // ceremony.
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: cus.id })
    await stripe.customers.update(cus.id, {
      invoice_settings: { default_payment_method: pm.id },
    })
    customerIds.push(cus.id)
    console.log(`    customer ${cus.id}  ${profile.name}`)
  }

  // 3. Walk this clock's slice of the plan. `customerOffset` maps from
  // the global PLAN's `who` index to this chunk's local 0..N index.
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
      // Wait for ready — Stripe's `advance` returns before the clock
      // finishes processing the elapsed period. Hitting it again (or
      // making any other modification) before then fails with 429.
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

  // 4. Final advance to "now" so the dashboard reads in the present.
  const finalUnix = Math.floor(Date.now() / 1000)
  await advanceClockAndWait(clock.id, finalUnix)
  console.log(`  → advanced to now`)

  return clock.id
}

// ─── Main ──────────────────────────────────────────────────────────────────

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

  // Each chunk's customer IDs in the global PLAN are offset by their
  // chunk's start index — chunk 0 covers PLAN.who 0..2, chunk 1 covers
  // 3..5, etc. We pass that offset so each clock can resolve its slice.
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
  console.log('  Charges land in stripe_charges via webhook (already plugged in).')
  console.log('  Subscriptions + customers populate on the next backfill/reconcile.')
  console.log(
    '\n  To clean up: Stripe Dashboard → Developers → Test clocks → delete each.',
  )
}

main().catch(err => {
  console.error('\n✗ seed failed:', err.message)
  if (err.raw) console.error('  raw:', err.raw)
  process.exit(1)
})
