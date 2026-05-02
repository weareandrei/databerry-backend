#!/usr/bin/env node
/**
 * Standalone customer-dedupe tool.
 *
 * Why: re-running the seed script (or, in production, a real user checking
 * out multiple times unauthenticated) creates several Stripe customers
 * with the same identity (email + name) but different `cus_xxx` IDs.
 * Each ends up as a separate row in `stripe_customers`, and charges
 * scatter across them — so the "Top Customers" tile shows the same
 * person multiple times with split revenue. Read-time dedup is one fix;
 * cleaning the data at the source is the other (this script).
 *
 * What this does, per `stripe_account_id`:
 *   1. Group `stripe_customers` rows by **lowercased email** (primary
 *      identity key) — falling back to **lowercased name** when email is
 *      missing. Customers with neither email nor name keep their own
 *      group of one (no dedup possible, by design).
 *   2. For each group with > 1 row:
 *      a. Pick a *canonical* row — the one with the lowest `created`
 *         timestamp (oldest first). Stable, deterministic.
 *      b. Re-point every `stripe_charges.customer_id` and
 *         `stripe_subscriptions.customer_id` from each duplicate ID to
 *         the canonical one. Note: these columns are plain TEXT, not FK,
 *         so re-pointing is just an UPDATE.
 *      c. DELETE the duplicate rows from `stripe_customers`.
 *
 * Idempotent. Safe to re-run after the seed script creates new dupes.
 *
 * Run from backend/:
 *   node test/manual/dedupe-customers.js
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.testing') })

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STRIPE_ACCT = process.env.STRIPE_CONNECTED_ACCOUNT

if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_ACCT) {
  console.error('✗ Missing one of: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_CONNECTED_ACCOUNT')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function identityKey(c) {
  if (c.email) return `email:${c.email.trim().toLowerCase()}`
  if (c.name) return `name:${c.name.trim().toLowerCase()}`
  return `id:${c.id}` // unique, no dedup
}

async function main() {
  console.log(`\n► dedupe-customers  account=${STRIPE_ACCT}\n`)

  // 1. Pull all customers for the account, oldest first.
  const { data: customers, error } = await supabase
    .from('stripe_customers')
    .select('id, name, email, created')
    .eq('stripe_account_id', STRIPE_ACCT)
    .order('created', { ascending: true })

  if (error) {
    console.error(`✗ failed to list customers: ${error.message}`)
    process.exit(1)
  }
  if (!customers || customers.length === 0) {
    console.log('(no customers for this account)')
    return
  }
  console.log(`Found ${customers.length} customer row(s).`)

  // 2. Group by identity.
  const groups = new Map() // identity → [customers, sorted by created ASC]
  for (const c of customers) {
    const key = identityKey(c)
    const arr = groups.get(key) ?? []
    arr.push(c)
    groups.set(key, arr)
  }

  const dupeGroups = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1)
  console.log(`Identity groups:        ${groups.size}`)
  console.log(`Groups with duplicates: ${dupeGroups.length}\n`)

  if (dupeGroups.length === 0) {
    console.log('Nothing to dedupe — every identity already has exactly one row.')
    return
  }

  let totalChargesRepointed = 0
  let totalSubsRepointed = 0
  let totalDeletedRows = 0

  // 3. For each duplicate group: re-point charges/subs, delete extras.
  for (const [key, group] of dupeGroups) {
    // Already sorted ASC by `created`; oldest is canonical.
    const canonical = group[0]
    const dupes = group.slice(1)
    const dupeIds = dupes.map(c => c.id)

    const label = canonical.email ?? canonical.name ?? canonical.id
    console.log(
      `► ${key.padEnd(40)} ${dupes.length} dupe(s) → canonical=${canonical.id}`,
    )

    // Re-point charges
    const { data: chargesUpdated, error: chErr } = await supabase
      .from('stripe_charges')
      .update({ customer_id: canonical.id })
      .eq('stripe_account_id', STRIPE_ACCT)
      .in('customer_id', dupeIds)
      .select('id')
    if (chErr) {
      console.log(`    ✗ charges update failed: ${chErr.message}`)
      continue
    }
    const chargeCount = chargesUpdated?.length ?? 0
    totalChargesRepointed += chargeCount

    // Re-point subscriptions
    const { data: subsUpdated, error: subErr } = await supabase
      .from('stripe_subscriptions')
      .update({ customer_id: canonical.id })
      .eq('stripe_account_id', STRIPE_ACCT)
      .in('customer_id', dupeIds)
      .select('id')
    if (subErr) {
      console.log(`    ✗ subscriptions update failed: ${subErr.message}`)
      continue
    }
    const subCount = subsUpdated?.length ?? 0
    totalSubsRepointed += subCount

    // Delete the duplicate customer rows
    const { error: delErr } = await supabase
      .from('stripe_customers')
      .delete()
      .in('id', dupeIds)
    if (delErr) {
      console.log(`    ✗ delete dupes failed: ${delErr.message}`)
      continue
    }
    totalDeletedRows += dupeIds.length

    console.log(
      `    ✓ ${label}  charges=${chargeCount}  subs=${subCount}  deleted=${dupeIds.length}`,
    )
  }

  console.log('\n── summary ──')
  console.log(`  customer rows deleted   : ${totalDeletedRows}`)
  console.log(`  charges re-pointed      : ${totalChargesRepointed}`)
  console.log(`  subscriptions re-pointed: ${totalSubsRepointed}`)

  const { count: remaining } = await supabase
    .from('stripe_customers')
    .select('*', { count: 'exact', head: true })
    .eq('stripe_account_id', STRIPE_ACCT)
  console.log(`\n  stripe_customers rows for account (after): ${remaining ?? 0}`)
}

main().catch(err => {
  console.error('\n✗', err.message)
  process.exit(1)
})
