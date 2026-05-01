#!/usr/bin/env node
/**
 * Diagnose where the Stripe → Databerry pipeline is broken.
 *
 * The five places things can fail:
 *   1. Stripe doesn't actually have the data       → check via Stripe API
 *   2. Backfill never ran / errored                → stripe_accounts.backfill_status
 *   3. Webhook didn't fire / wasn't accepted       → stripe_charges row count
 *   4. Connection points at a different account    → connection.stripe_account_id
 *   5. View points at a different connection       → view.connection_id
 *
 * This script walks all five and prints what it finds. Run from backend/:
 *   node test/manual/diagnose-stripe-pipeline.js
 *
 * It uses the SAME Supabase service-role key the running app uses (read
 * from .env), and the SAME Stripe key the seed script uses (read from
 * .env.testing). So whatever it sees is what the dashboard sees.
 */

const path = require('path')
// Backend's .env (Supabase credentials)
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
// Test secrets (overrides STRIPE_SECRET_KEY etc. if set there)
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.testing') })

const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY
const STRIPE_ACCT = process.env.STRIPE_CONNECTED_ACCOUNT

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env')
  process.exit(1)
}
if (!STRIPE_KEY || !STRIPE_ACCT) {
  console.error('✗ Missing STRIPE_SECRET_KEY or STRIPE_CONNECTED_ACCOUNT in backend/.env.testing')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const stripe = new Stripe(STRIPE_KEY, { stripeAccount: STRIPE_ACCT })

// ─── Helpers ───────────────────────────────────────────────────────────────

function divider(label) {
  console.log(`\n══ ${label} ${'═'.repeat(Math.max(0, 76 - label.length))}`)
}

async function safeCount(table, filter) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count, error } = await q
  if (error) return `ERROR: ${error.message}`
  return count ?? 0
}

// ─── Steps ─────────────────────────────────────────────────────────────────

async function step1_stripeHasData() {
  divider('1. Does Stripe have the data?')
  // Page through to get true counts (capped at 100 per page; we just want
  // total visibility here, not pagination).
  const charges = await stripe.charges.list({ limit: 100 })
  const customers = await stripe.customers.list({ limit: 100 })
  const subs = await stripe.subscriptions.list({ limit: 100, status: 'all' })
  console.log(`  Connected account: ${STRIPE_ACCT}`)
  console.log(`  Charges in Stripe   : ${charges.data.length}${charges.has_more ? '+' : ''} returned`)
  console.log(`  Customers in Stripe : ${customers.data.length}${customers.has_more ? '+' : ''} returned`)
  console.log(`  Subscriptions       : ${subs.data.length}${subs.has_more ? '+' : ''} returned`)
  if (charges.data.length > 0) {
    const newest = new Date(charges.data[0].created * 1000).toISOString()
    const oldest = new Date(charges.data[charges.data.length - 1].created * 1000).toISOString()
    console.log(`  Charge timestamp range: ${oldest}  →  ${newest}`)
  } else {
    console.log('  ⚠ No charges in Stripe — seeding never ran or hit a different account.')
  }
}

async function step2_stripeAccountsTable() {
  divider('2. stripe_accounts (backfill status)')
  const { data, error } = await supabase
    .from('stripe_accounts')
    .select('id, livemode, backfill_status, backfill_error, backfilled_through, last_synced_at, created_at')
    .order('created_at', { ascending: false })
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    console.log('  (empty) — no Stripe accounts in the DB. Did the connection-create flow run?')
    return
  }
  for (const row of data) {
    const matchesEnv = row.id === STRIPE_ACCT ? '  ← matches .env.testing' : ''
    console.log(`  ${row.id}  livemode=${row.livemode}  backfill=${row.backfill_status}${matchesEnv}`)
    if (row.backfill_error) console.log(`    ⚠ error: ${row.backfill_error}`)
    if (row.backfilled_through) console.log(`    backfilled_through: ${row.backfilled_through}`)
    if (row.last_synced_at) console.log(`    last_synced_at:     ${row.last_synced_at}`)
  }
}

async function step3_dataCountsPerAccount() {
  divider('3. Row counts in DB (per stripe_account_id)')
  const { data: accounts } = await supabase.from('stripe_accounts').select('id')
  if (!accounts || accounts.length === 0) {
    console.log('  no accounts to check')
    return
  }
  for (const a of accounts) {
    const eq = q => q.eq('stripe_account_id', a.id)
    const [charges, customers, subs, lineItems, products] = await Promise.all([
      safeCount('stripe_charges', eq),
      safeCount('stripe_customers', eq),
      safeCount('stripe_subscriptions', eq),
      safeCount('stripe_line_items', eq),
      safeCount('stripe_products', eq),
    ])
    const tag = a.id === STRIPE_ACCT ? '  ← target' : ''
    console.log(`  ${a.id}${tag}`)
    console.log(`    charges=${charges}  line_items=${lineItems}  customers=${customers}  subs=${subs}  products=${products}`)
  }
}

async function step4_recentCharges() {
  divider('4. Recent stripe_charges rows (DB-side)')
  const { data, error } = await supabase
    .from('stripe_charges')
    .select('id, stripe_account_id, amount, currency, status, created, customer_id')
    .eq('stripe_account_id', STRIPE_ACCT)
    .order('created', { ascending: false })
    .limit(10)
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    console.log(`  (empty) — no charges for ${STRIPE_ACCT} in stripe_charges.`)
    console.log('  This is the smoking gun. Either:')
    console.log('    - the webhook never fired (check Stripe dashboard → Developers → Webhooks)')
    console.log('    - or the backfill never ran / it errored (see step 2)')
    return
  }
  for (const r of data) {
    const amt = (r.amount / 100).toFixed(2)
    console.log(`  ${r.created}  ${amt.padStart(8)} ${r.currency.toUpperCase()}  ${r.status}  ${r.id}  cust=${r.customer_id ?? '-'}`)
  }
}

async function step5_connectionsAndViews() {
  divider('5. Connections + Views (FK chain to stripe_account_id)')
  const { data: stripeConns } = await supabase
    .from('connections')
    .select('id, name, type, project_id, user_id, created_at')
    .in('type', ['stripe', 'stripe_manual'])
    .order('created_at', { ascending: false })

  if (!stripeConns || stripeConns.length === 0) {
    console.log('  (no stripe connections in `connections` table)')
    return
  }

  for (const conn of stripeConns) {
    // Resolve stripe_account_id for this connection
    const credTable =
      conn.type === 'stripe' ? 'connections_stripe' : 'connections_stripe_manual'
    const { data: cred } = await supabase
      .from(credTable)
      .select('stripe_account_id, tracked_product_ids')
      .eq('connection_id', conn.id)
      .maybeSingle()

    const acctId = cred?.stripe_account_id ?? '<not set>'
    const targetTag = acctId === STRIPE_ACCT ? '  ✔ matches target' : '  ✗ DIFFERENT account'
    console.log(`\n  connection ${conn.id}  (${conn.type})  "${conn.name}"`)
    console.log(`    project_id          : ${conn.project_id ?? '(common)'}`)
    console.log(`    stripe_account_id   : ${acctId}${targetTag}`)
    console.log(`    tracked_product_ids : ${JSON.stringify(cred?.tracked_product_ids ?? [])}`)

    // Views attached to this connection
    const { data: views, error: vErr } = await supabase
      .from('views')
      .select('id, type, name, project_id, folder_id')
      .eq('connection_id', conn.id)

    if (vErr) {
      console.log(`    views               : ERROR ${vErr.message}`)
    } else if (!views || views.length === 0) {
      console.log('    views               : (none)')
    } else {
      console.log(`    views (${views.length}):`)
      for (const v of views) {
        console.log(`      • ${v.type.padEnd(24)} ${v.id}`)
      }
    }
  }
}

async function step6_allStripeShapedViews() {
  divider('6. ALL views with stripe-shaped types (regardless of connection)')
  const { data: views, error } = await supabase
    .from('views')
    .select('id, type, name, connection_id, connection_type, project_id, created_at')
    .like('type', 'stripe%')
    .order('created_at', { ascending: false })
  if (error) {
    console.log(`  ERROR: ${error.message}`)
    return
  }
  if (!views || views.length === 0) {
    console.log('  (no views with type LIKE stripe%) — the user may have only views of a different type.')
    console.log('  Check the dashboard for which view types are actually pinned/displayed.')
    return
  }
  for (const v of views) {
    // Resolve whether this view's connection_id still exists
    let connStatus = '<no connection_id>'
    if (v.connection_id) {
      const { data: conn } = await supabase
        .from('connections')
        .select('id, name, type')
        .eq('id', v.connection_id)
        .maybeSingle()
      connStatus = conn ? `${conn.type} "${conn.name}"` : '⚠ DANGLING (connection deleted)'
    }
    console.log(`  ${v.created_at}  ${v.type.padEnd(24)}  conn=${connStatus}`)
    console.log(`    view_id=${v.id}  value=${v.value ?? '—'}`)
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await step1_stripeHasData()
  await step2_stripeAccountsTable()
  await step3_dataCountsPerAccount()
  await step4_recentCharges()
  await step5_connectionsAndViews()
  await step6_allStripeShapedViews()
  console.log('')
}

main().catch(err => {
  console.error('\n✗', err.message)
  process.exit(1)
})
