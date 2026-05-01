#!/usr/bin/env node
/**
 * Quick diagnostic — lists the most recent charges on the connected
 * account and shows their actual `created` timestamps. Used to verify
 * whether Test Clocks actually backdate explicit-API charges or only
 * automatically-generated ones (subscription renewals).
 *
 * Run from the backend folder:
 *   node test/manual/check-charge-dates.js
 */

const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env.testing'),
})

const Stripe = require('stripe')

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  stripeAccount: process.env.STRIPE_CONNECTED_ACCOUNT,
})

async function main() {
  const charges = await stripe.charges.list({ limit: 30 })

  console.log(`Found ${charges.data.length} recent charges:\n`)
  for (const c of charges.data) {
    const created = new Date(c.created * 1000).toISOString()
    const amount = (c.amount / 100).toFixed(2)
    const cur = c.currency.toUpperCase()
    console.log(
      `  ${created}  ${amount.padStart(8)} ${cur}  ${c.id}  cust=${c.customer ?? '-'}  ${c.description ?? ''}`,
    )
  }

  console.log('\nGrouping by date:')
  const byDate = new Map()
  for (const c of charges.data) {
    const d = new Date(c.created * 1000).toISOString().slice(0, 10)
    byDate.set(d, (byDate.get(d) ?? 0) + 1)
  }
  for (const [d, n] of [...byDate.entries()].sort()) {
    console.log(`  ${d}: ${n} charge${n > 1 ? 's' : ''}`)
  }
}

main().catch(err => {
  console.error('✗', err.message)
  process.exit(1)
})
