#!/usr/bin/env node
/**
 * One-shot duplicate diagnostic.
 *
 * Each Stripe entity (charge, customer, subscription, invoice, line_item)
 * has a different "natural identity" — and a different shape of duplicate
 * to look for. This script asks the right question per table:
 *
 *   stripe_customers      — same email / same name across multiple `cus_*` IDs?
 *                           (Yes is normal; Stripe Checkout creates a new
 *                           customer for every anonymous payment.)
 *   stripe_charges        — multiple DB rows with the same `id` (PK)? Should
 *                           be impossible. Multiple rows for the same
 *                           payment_intent? Possible but rare.
 *   stripe_subscriptions  — multiple rows with the same `id`? Same answer.
 *   stripe_invoices       — same.
 *   stripe_line_items     — multiple rows with the same (charge_id, product_id)?
 *                           That'd indicate the resolver inserted twice.
 *
 * Reports per stripe_account_id. Read-only — touches nothing.
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.testing') })

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STRIPE_ACCT = process.env.STRIPE_CONNECTED_ACCOUNT

if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_ACCT) {
  console.error('✗ Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_CONNECTED_ACCOUNT')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function divider(label) {
  console.log(`\n══ ${label} ${'═'.repeat(Math.max(0, 76 - label.length))}`)
}

async function checkCustomers() {
  divider('stripe_customers — by email/name identity')
  const { data, error } = await supabase
    .from('stripe_customers')
    .select('id, email, name, created')
    .eq('stripe_account_id', STRIPE_ACCT)
    .order('created', { ascending: true })
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  console.log(`  total rows: ${data.length}`)

  const groups = new Map()
  for (const c of data) {
    const key = c.email
      ? `email:${c.email.trim().toLowerCase()}`
      : c.name
        ? `name:${c.name.trim().toLowerCase()}`
        : `id:${c.id}`
    const arr = groups.get(key) ?? []
    arr.push(c)
    groups.set(key, arr)
  }
  const dupes = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1)
  console.log(`  identity groups: ${groups.size}`)
  console.log(`  groups w/ dupes: ${dupes.length}`)
  if (dupes.length > 0) {
    let extraRows = 0
    for (const [key, arr] of dupes) {
      extraRows += arr.length - 1
      console.log(`    ${key.padEnd(50)} ${arr.length} rows`)
    }
    console.log(`  → ${extraRows} extra row(s) would be merged by dedupe-customers.js`)
  }
}

async function checkExactIdDupes(table, label) {
  divider(`${table} — same row ID twice (hard duplicates)`)
  // Postgres PKs make this impossible by definition for `id`. The check is
  // really about whether the table has a true PK on id. If there's no PK
  // (legacy), this would surface it.
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('stripe_account_id', STRIPE_ACCT)
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  const counts = new Map()
  for (const r of data) counts.set(r.id, (counts.get(r.id) ?? 0) + 1)
  const dupes = Array.from(counts.entries()).filter(([, n]) => n > 1)
  console.log(`  total rows: ${data.length}  unique ids: ${counts.size}  dupe ids: ${dupes.length}`)
  if (dupes.length > 0) {
    console.log('  ⚠ Same Stripe id present in multiple rows — table is missing a PK or the')
    console.log('    sync is bypassing UPSERT. Sample:')
    for (const [id, n] of dupes.slice(0, 5)) console.log(`    ${id}  × ${n}`)
  }
}

async function checkChargeDupesByPaymentIntent() {
  divider('stripe_charges — multiple rows per payment_intent')
  const { data, error } = await supabase
    .from('stripe_charges')
    .select('id, payment_intent_id, amount, created')
    .eq('stripe_account_id', STRIPE_ACCT)
  if (error) {
    // payment_intent_id might not exist as a column — soft-fail.
    console.log(`  (column not present, skipping: ${error.message})`)
    return
  }
  const byPi = new Map()
  for (const c of data) {
    if (!c.payment_intent_id) continue
    const arr = byPi.get(c.payment_intent_id) ?? []
    arr.push(c)
    byPi.set(c.payment_intent_id, arr)
  }
  const dupes = Array.from(byPi.entries()).filter(([, arr]) => arr.length > 1)
  console.log(`  charges with PI: ${data.filter(c => c.payment_intent_id).length}`)
  console.log(`  payment_intents w/ multiple charges: ${dupes.length}`)
  if (dupes.length > 0) {
    console.log('  Sample:')
    for (const [pi, arr] of dupes.slice(0, 5)) console.log(`    ${pi}  × ${arr.length} charges`)
  }
}

async function checkLineItemDupes() {
  divider('stripe_line_items — duplicate (charge_id, product_id) within same row')
  const { data, error } = await supabase
    .from('stripe_line_items')
    .select('charge_id, product_id, amount')
    .eq('stripe_account_id', STRIPE_ACCT)
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  console.log(`  total rows: ${data.length}`)
  const composite = new Map()
  for (const li of data) {
    const k = `${li.charge_id}::${li.product_id}`
    composite.set(k, (composite.get(k) ?? 0) + 1)
  }
  const dupes = Array.from(composite.entries()).filter(([, n]) => n > 1)
  console.log(`  unique (charge_id, product_id): ${composite.size}`)
  console.log(`  combos with > 1 row:            ${dupes.length}`)
  if (dupes.length > 0) {
    console.log('  Sample:')
    for (const [k, n] of dupes.slice(0, 5)) console.log(`    ${k}  × ${n}`)
  }
}

async function main() {
  console.log(`\n► dupe-check  account=${STRIPE_ACCT}`)
  await checkCustomers()
  await checkExactIdDupes('stripe_charges', 'charges')
  await checkExactIdDupes('stripe_subscriptions', 'subscriptions')
  await checkExactIdDupes('stripe_invoices', 'invoices')
  await checkChargeDupesByPaymentIntent()
  await checkLineItemDupes()
  console.log('')
}

main().catch(err => {
  console.error('\n✗', err.message)
  process.exit(1)
})
