#!/usr/bin/env node
/**
 * Tiny "live-time" seed — adds 3 small charges (one per product) at
 * the real wall-clock moment, no Test Clocks involved. Use it to nudge
 * today's totals on the dashboard with a bit of noise without touching
 * historical buckets.
 *
 * What it does:
 *   - Creates ONE throwaway customer (uniquified by a timestamp suffix
 *     so reruns never dedupe against a previous noise batch).
 *   - Charges them once for each product:
 *       1. 41 RON one-time
 *       2. 25 RON one-time
 *       3. 15 RON / month subscription (first invoice charges
 *          immediately; future renewals will recur monthly)
 *
 * Why no Test Clock? Clocks only backdate auto-renewals; for `invoices.
 * create + .pay` they don't move the charge `created` timestamp. So if
 * you want charges that land RIGHT NOW (and they show on today's bar in
 * the chart), skipping the clock is both simpler and more accurate.
 *
 * Run from the backend folder:
 *   node test/manual/stripe-test-charges-now.js
 */

const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env.testing'),
})

const Stripe = require('stripe')

const SECRET_KEY = process.env.STRIPE_SECRET_KEY
const CONNECTED_ACCOUNT = process.env.STRIPE_CONNECTED_ACCOUNT

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

const PRODUCTS = {
  P41: 'prod_UQSgjwsOvdzpk6', // 41 RON one-time
  P25: 'prod_UQSg7cDR95tDlw', // 25 RON one-time
  SUB: 'prod_UQSfxHRqtKUI7l', // 15 RON / month
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

async function subscribe(customerId, priceId) {
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
  })
}

async function main() {
  console.log('Looking up active prices…')
  const [P41, P25, SUB] = await Promise.all([
    activePriceFor(PRODUCTS.P41),
    activePriceFor(PRODUCTS.P25),
    activePriceFor(PRODUCTS.SUB),
  ])
  console.log(`  41 RON     → ${P41}`)
  console.log(`  25 RON     → ${P25}`)
  console.log(`  15/mo sub  → ${SUB}`)

  // Timestamp-suffixed email + name so each run produces a uniquely-
  // identifiable customer (dedupe-customers.js can spot batches by
  // the "Noise " name prefix if cleanup is ever needed).
  const stamp = Date.now().toString(36)
  const profile = {
    name: `Noise ${stamp}`,
    email: `noise-${stamp}@test.example`,
  }

  console.log(`\nCreating customer ${profile.name} (${profile.email})…`)
  const cus = await stripe.customers.create({
    name: profile.name,
    email: profile.email,
  })
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: cus.id })
  await stripe.customers.update(cus.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  console.log(`  customer ${cus.id}`)

  console.log('\nMaking 3 small sales (one per product):')

  const r41 = await payOneTime(cus.id, P41, '41 RON')
  console.log(`  ${r41.label}: ${r41.invoiceId} → ${r41.status}`)

  const r25 = await payOneTime(cus.id, P25, '25 RON')
  console.log(`  ${r25.label}: ${r25.invoiceId} → ${r25.status}`)

  const sub = await subscribe(cus.id, SUB)
  console.log(`  15 RON sub: ${sub.id} → ${sub.status}  (first invoice charges immediately)`)

  console.log('\nDone.')
  console.log('  Charges land in stripe_charges via webhook (or via "Refresh data from Stripe").')
}

main().catch(err => {
  console.error('\n✗ noise seed failed:', err.message)
  if (err.raw) console.error('  raw:', err.raw)
  process.exit(1)
})
