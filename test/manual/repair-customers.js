#!/usr/bin/env node
/**
 * Standalone customer-table repair tool.
 *
 * Why this exists: Stripe's `customers.list` endpoint silently omits
 * customers attached to old/deleted test clocks (and probably some other
 * lifecycle states). Re-running a seed script over the same account
 * produces fresh customer rows but the list endpoint only ever returns
 * the most-recent batch — yet the historical charges still reference
 * the older customer IDs. Result: `stripe_charges.customer_id` points at
 * IDs that aren't in `stripe_customers`, and the "Top Customers" tile
 * renders blank rows because the join misses.
 *
 * What this does, per orphan reference in `stripe_charges`:
 *   1. Skip if a row for that customer already exists in DB.
 *   2. `GET /v1/customers/{id}` directly (works even when list omits it).
 *   3. Upsert into `stripe_customers` with name + email + address.
 *
 * Idempotent. Safe to re-run. Bypasses the NestJS backend so it works
 * regardless of which version of the sync code is currently running.
 *
 * Run from backend/:
 *   node test/manual/repair-customers.js
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.testing') })

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY
const STRIPE_ACCT = process.env.STRIPE_CONNECTED_ACCOUNT

if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_KEY || !STRIPE_ACCT) {
  console.error('✗ Missing one of: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_CONNECTED_ACCOUNT')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const stripe = new Stripe(STRIPE_KEY, { stripeAccount: STRIPE_ACCT })

async function main() {
  console.log(`\n► repair-customers  account=${STRIPE_ACCT}\n`)

  // 1. Collect every customer_id referenced by charges in this account.
  const { data: charges, error: chErr } = await supabase
    .from('stripe_charges')
    .select('customer_id')
    .eq('stripe_account_id', STRIPE_ACCT)
    .not('customer_id', 'is', null)
  if (chErr) {
    console.error(`✗ failed to list charges: ${chErr.message}`)
    process.exit(1)
  }
  const referenced = new Set(charges.map(r => r.customer_id))
  console.log(`Distinct customer_ids referenced by charges: ${referenced.size}`)

  // 2. Find which of those are missing from stripe_customers.
  const ids = Array.from(referenced)
  const { data: existing, error: cuErr } = await supabase
    .from('stripe_customers')
    .select('id')
    .eq('stripe_account_id', STRIPE_ACCT)
    .in('id', ids)
  if (cuErr) {
    console.error(`✗ failed to list customers: ${cuErr.message}`)
    process.exit(1)
  }
  const present = new Set((existing ?? []).map(r => r.id))
  const missing = ids.filter(id => !present.has(id))
  console.log(`Already in DB:    ${present.size}`)
  console.log(`Missing from DB:  ${missing.length}\n`)

  if (missing.length === 0) {
    console.log('Nothing to repair — every referenced customer is in DB.')
    return
  }

  // 3. Retrieve each missing customer directly from Stripe and upsert.
  const totals = { fetched: 0, errored: 0, deleted: 0 }
  for (const id of missing) {
    try {
      const c = await stripe.customers.retrieve(id)
      // Stripe returns `{ id, deleted: true }` for deleted customers — skip
      // those (no usable name/email/created to persist).
      if (c.deleted) {
        console.log(`  – ${id}  deleted in Stripe, skipping`)
        totals.deleted++
        continue
      }

      const row = {
        id: c.id,
        stripe_account_id: STRIPE_ACCT,
        name: c.name ?? null,
        email: c.email ?? null,
        address_country: c.address?.country ?? null,
        address_city: c.address?.city ?? null,
        created: new Date(c.created * 1000).toISOString(),
      }
      const { error: upErr } = await supabase
        .from('stripe_customers')
        .upsert(row, { onConflict: 'id' })
      if (upErr) {
        console.log(`  ✗ ${id}  upsert failed: ${upErr.message}`)
        totals.errored++
        continue
      }
      const tag = `${c.name ?? '(no name)'}  ${c.email ?? '(no email)'}`
      console.log(`  ✓ ${id}  ${tag}`)
      totals.fetched++
    } catch (err) {
      console.log(`  ✗ ${id}  retrieve failed: ${err.message}`)
      totals.errored++
    }
  }

  console.log('\n── summary ──')
  console.log(`  fetched + upserted: ${totals.fetched}`)
  console.log(`  deleted in Stripe : ${totals.deleted}`)
  console.log(`  errors            : ${totals.errored}`)

  const { count } = await supabase
    .from('stripe_customers')
    .select('*', { count: 'exact', head: true })
    .eq('stripe_account_id', STRIPE_ACCT)
  console.log(`\n  stripe_customers total rows for account: ${count ?? 0}`)
}

main().catch(err => {
  console.error('\n✗', err.message)
  process.exit(1)
})
