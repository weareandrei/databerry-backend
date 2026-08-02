#!/usr/bin/env node
/**
 * Seed Databerry's cached Stripe tables directly in Supabase for the past 2 weeks.
 *
 * Why this exists:
 *   - The "real Stripe" scripts under test/manual create genuine Stripe test-mode
 *     objects, which is useful for webhook/sync testing.
 *   - Sometimes we want dashboard-only data without touching Stripe at all.
 *
 * This script does that by writing to:
 *   - stripe_customers
 *   - stripe_charges
 *   - stripe_line_items
 *
 * It resolves the project's test Stripe account the same way the app does:
 *   project-specific connection first, then Common (`project_id IS NULL`).
 * If the connection has tracked_product_ids, only those products are used.
 * Otherwise it uses the account's active cached products.
 *
 * Run from backend/ or repo root:
 *   node backend/test/manual/stripe-db-seed-two-weeks.js
 *
 * Optional env overrides:
 *   DBB_PROJECT_ID=...
 *   DBB_DAYS_BACK=14
 */

const path = require('path')
const crypto = require('crypto')

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.testing') })

const { createClient } = require('@supabase/supabase-js')

const PROJECT_ID =
  process.env.DBB_PROJECT_ID ?? '3b162381-9ffb-4f92-8ceb-9ff3b4b30551'
const DAYS_BACK = Number(process.env.DBB_DAYS_BACK ?? 14)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env')
  process.exit(1)
}

if (!Number.isFinite(DAYS_BACK) || DAYS_BACK <= 0) {
  console.error(`✗ Invalid DBB_DAYS_BACK=${process.env.DBB_DAYS_BACK ?? '<unset>'}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CUSTOMER_PROFILES = [
  { name: 'DB Seed Atlas', email: 'db-seed-atlas@test.example' },
  { name: 'DB Seed Nova', email: 'db-seed-nova@test.example' },
  { name: 'DB Seed Sol', email: 'db-seed-sol@test.example' },
  { name: 'DB Seed Vega', email: 'db-seed-vega@test.example' },
]

const SALES_PLAN = [
  { customerEmail: 'db-seed-atlas@test.example', productSlot: 1, amountCents: 4100, quantity: 1, daysAgo: 13 },
  // Jul 20 / Jul 21 (from Aug 1)
  { customerEmail: 'db-seed-sol@test.example',   productSlot: 1, amountCents: 2500, quantity: 1, daysAgo: 12 },
  { customerEmail: 'db-seed-nova@test.example',  productSlot: 2, amountCents: 2500, quantity: 1, daysAgo: 11 },
  { customerEmail: 'db-seed-atlas@test.example', productSlot: 1, amountCents: 4100, quantity: 1, daysAgo: 11 },
  { customerEmail: 'db-seed-sol@test.example',   productSlot: 1, amountCents: 4100, quantity: 1, daysAgo: 9 },
  { customerEmail: 'db-seed-atlas@test.example', productSlot: 3, amountCents: 1500, quantity: 1, daysAgo: 7 },
  // Jul 26 / Jul 27
  { customerEmail: 'db-seed-nova@test.example',  productSlot: 1, amountCents: 1500, quantity: 1, daysAgo: 6 },
  { customerEmail: 'db-seed-vega@test.example',  productSlot: 2, amountCents: 5000, quantity: 2, daysAgo: 5 },
  { customerEmail: 'db-seed-sol@test.example',   productSlot: 2, amountCents: 2500, quantity: 1, daysAgo: 5 },
  // Jul 29
  { customerEmail: 'db-seed-nova@test.example',  productSlot: 1, amountCents: 4100, quantity: 1, daysAgo: 3 },
  { customerEmail: 'db-seed-vega@test.example',  productSlot: 2, amountCents: 2500, quantity: 1, daysAgo: 3 },
  { customerEmail: 'db-seed-atlas@test.example', productSlot: 2, amountCents: 2500, quantity: 1, daysAgo: 2 },
  { customerEmail: 'db-seed-sol@test.example',   productSlot: 3, amountCents: 1500, quantity: 1, daysAgo: 1 },
  { customerEmail: 'db-seed-vega@test.example',  productSlot: 1, amountCents: 4100, quantity: 1, daysAgo: 0 },
]

function divider(label) {
  console.log(`\n══ ${label} ${'═'.repeat(Math.max(0, 76 - label.length))}`)
}

function hash(input, length = 24) {
  return crypto.createHash('md5').update(input).digest('hex').slice(0, length)
}

function isoDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

async function resolveTargetConnection(projectId) {
  divider('1. Resolve target connection')

  const { data: connections, error } = await supabase
    .from('connections')
    .select('id, name, type, project_id, created_at')
    .in('type', ['stripe', 'stripe_manual'])
    .or(`project_id.eq.${projectId},project_id.is.null`)
    .order('project_id', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) throw new Error(`connections read failed: ${error.message}`)
  if (!connections || connections.length === 0) {
    throw new Error(`No Stripe connections found for project ${projectId}`)
  }

  const resolved = []
  for (const conn of connections) {
    const credTable =
      conn.type === 'stripe' ? 'connections_stripe' : 'connections_stripe_manual'

    const { data: cred, error: credErr } = await supabase
      .from(credTable)
      .select('stripe_account_id, tracked_product_ids')
      .eq('connection_id', conn.id)
      .maybeSingle()

    if (credErr) throw new Error(`${credTable} read failed: ${credErr.message}`)
    if (!cred?.stripe_account_id) continue

    const { data: account, error: accErr } = await supabase
      .from('stripe_accounts')
      .select('id, display_name, livemode, backfill_status')
      .eq('id', cred.stripe_account_id)
      .maybeSingle()

    if (accErr) throw new Error(`stripe_accounts read failed: ${accErr.message}`)
    if (!account || account.livemode !== false) continue

    resolved.push({
      connectionId: conn.id,
      connectionName: conn.name,
      connectionType: conn.type,
      projectId: conn.project_id,
      stripeAccountId: account.id,
      displayName: account.display_name,
      backfillStatus: account.backfill_status,
      trackedProductIds: cred.tracked_product_ids ?? [],
    })
  }

  if (resolved.length === 0) {
    throw new Error(`No test-mode Stripe account found for project ${projectId}`)
  }

  const chosen =
    resolved.find(r => r.projectId === projectId) ??
    resolved[0]

  console.log(`  connection        : ${chosen.connectionName} (${chosen.connectionType})`)
  console.log(`  project scope     : ${chosen.projectId ?? '(common)'}`)
  console.log(`  stripe account    : ${chosen.stripeAccountId}`)
  console.log(`  account name      : ${chosen.displayName ?? '<none>'}`)
  console.log(`  backfill status   : ${chosen.backfillStatus ?? '<none>'}`)
  console.log(`  tracked products  : ${JSON.stringify(chosen.trackedProductIds)}`)

  if (resolved.length > 1) {
    console.log(`  note              : ${resolved.length} eligible Stripe connection(s) found, using the first preferred match`)
  }

  return chosen
}

async function loadAttachedProducts(target) {
  divider('2. Load attached products')

  let query = supabase
    .from('stripe_products')
    .select('id, name, active')
    .eq('stripe_account_id', target.stripeAccountId)
    .eq('active', true)
    .order('name', { ascending: true })

  if (target.trackedProductIds.length > 0) {
    query = query.in('id', target.trackedProductIds)
  }

  const { data: products, error } = await query
  if (error) throw new Error(`stripe_products read failed: ${error.message}`)
  if (!products || products.length === 0) {
    throw new Error(
      target.trackedProductIds.length > 0
        ? 'No active cached products matched tracked_product_ids for this connection'
        : 'No active cached products found for this Stripe account',
    )
  }

  products.forEach((product, idx) => {
    console.log(`  [${idx + 1}] ${product.name}  ${product.id}`)
  })

  return products
}

async function upsertFakeCustomers(stripeAccountId) {
  divider('3. Upsert fake customers')

  const rows = CUSTOMER_PROFILES.map(profile => ({
    id: `cus_fake_${hash(profile.email, 20)}`,
    stripe_account_id: stripeAccountId,
    name: profile.name,
    email: profile.email,
    created: isoDaysAgo(DAYS_BACK),
  }))

  const { data, error } = await supabase
    .from('stripe_customers')
    .upsert(rows, { onConflict: 'id' })
    .select('id, email')

  if (error) throw new Error(`stripe_customers upsert failed: ${error.message}`)

  console.log(`  upserted ${rows.length} customer(s)`)
  return data ?? rows.map(r => ({ id: r.id, email: r.email }))
}

function buildSeedRows({ stripeAccountId, customers, products }) {
  divider('4. Build charge plan')

  const customerByEmail = new Map(customers.map(c => [c.email, c.id]))

  const inWindow = SALES_PLAN.filter(step => step.daysAgo < DAYS_BACK)
  const usablePlan = inWindow.filter(step => step.productSlot <= products.length)
  const skippedWindow = SALES_PLAN.length - inWindow.length
  const skippedProducts = inWindow.length - usablePlan.length

  if (usablePlan.length === 0) {
    throw new Error(
      `No plan rows in the last ${DAYS_BACK} day(s) for ${products.length} attached product(s)`,
    )
  }

  if (skippedWindow > 0) {
    console.log(`  skipped ${skippedWindow} plan row(s) outside DBB_DAYS_BACK=${DAYS_BACK}`)
  }
  if (skippedProducts > 0) {
    console.log(`  skipped ${skippedProducts} plan row(s) because the account only has ${products.length} attached product(s)`)
  }

  const rows = usablePlan.map(step => {
    const customerId = customerByEmail.get(step.customerEmail)
    if (!customerId) {
      throw new Error(`Missing customer mapping for ${step.customerEmail}`)
    }

    const product = products[step.productSlot - 1]
    const seedKey = `${step.customerEmail}:${product.id}:${step.daysAgo}:${step.amountCents}:${step.quantity}`

    return {
      chargeId: `ch_fake_${hash(seedKey, 24)}`,
      lineItemId: `li_fake_${hash(`li:${seedKey}`, 24)}`,
      stripeAccountId,
      customerId,
      productId: product.id,
      productName: product.name,
      amountCents: step.amountCents,
      quantity: step.quantity,
      created: isoDaysAgo(step.daysAgo),
    }
  })

  for (const row of rows) {
    console.log(
      `  ${row.created.slice(0, 10)}  ${(row.amountCents / 100).toFixed(2).padStart(6)}  ${row.productName}  cust=${row.customerId}`,
    )
  }

  return rows
}

async function upsertCharges(rows) {
  divider('5. Upsert stripe_charges')

  const payload = rows.map(row => ({
    id: row.chargeId,
    stripe_account_id: row.stripeAccountId,
    amount: row.amountCents,
    amount_refunded: 0,
    currency: 'ron',
    status: 'succeeded',
    created: row.created,
    payment_intent_id: null,
    invoice_id: null,
    customer_id: row.customerId,
  }))

  const { error } = await supabase
    .from('stripe_charges')
    .upsert(payload, { onConflict: 'id' })

  if (error) throw new Error(`stripe_charges upsert failed: ${error.message}`)
  console.log(`  upserted ${payload.length} charge(s)`)
}

async function upsertLineItems(rows) {
  divider('6. Upsert stripe_line_items')

  const payload = rows.map(row => ({
    id: row.lineItemId,
    charge_id: row.chargeId,
    stripe_account_id: row.stripeAccountId,
    product_id: row.productId,
    price_id: null,
    amount: row.amountCents,
    quantity: row.quantity,
  }))

  const { error } = await supabase
    .from('stripe_line_items')
    .upsert(payload, { onConflict: 'id' })

  if (error) throw new Error(`stripe_line_items upsert failed: ${error.message}`)
  console.log(`  upserted ${payload.length} line item(s)`)
}

async function printSummary(target, rows) {
  divider('7. Summary')

  const productBreakdown = new Map()
  for (const row of rows) {
    const cur = productBreakdown.get(row.productName) ?? { count: 0, total: 0 }
    cur.count += 1
    cur.total += row.amountCents
    productBreakdown.set(row.productName, cur)
  }

  console.log(`  project id        : ${PROJECT_ID}`)
  console.log(`  stripe account    : ${target.stripeAccountId}`)
  console.log(`  days back         : ${DAYS_BACK}`)
  console.log(`  seeded charges    : ${rows.length}`)
  console.log(`  total gross       : ${(rows.reduce((sum, row) => sum + row.amountCents, 0) / 100).toFixed(2)} RON`)
  console.log('  by product:')
  for (const [name, stat] of productBreakdown.entries()) {
    console.log(`    ${name}: count=${stat.count} total=${(stat.total / 100).toFixed(2)} RON`)
  }
}

async function main() {
  const target = await resolveTargetConnection(PROJECT_ID)
  const products = await loadAttachedProducts(target)
  const customers = await upsertFakeCustomers(target.stripeAccountId)
  const rows = buildSeedRows({
    stripeAccountId: target.stripeAccountId,
    customers,
    products,
  })
  await upsertCharges(rows)
  await upsertLineItems(rows)
  await printSummary(target, rows)
}

main().catch(err => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
