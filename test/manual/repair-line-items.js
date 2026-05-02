#!/usr/bin/env node
/**
 * Standalone line-items repair tool.
 *
 * Bypasses the NestJS backend entirely so we can verify the new resolver
 * logic against your real data without depending on whether the dev server
 * was restarted with the latest code.
 *
 * What it does, per charge in `stripe_charges`:
 *   1. Skip if it already has rows in `stripe_line_items`.
 *   2. Resolve the invoice ID via `Charge.invoice` if present, OR via
 *      `/v1/invoice_payments?payment[type]=payment_intent
 *      &payment[payment_intent]=...` (the new bridge after Stripe deprecated
 *      Charge.invoice).
 *   3. Fetch the invoice and read line items from
 *      `lines.data[].pricing.price_details.{price, product}` (the new
 *      shape — `lines.data[].price` is gone in current API versions).
 *   4. INSERT into `stripe_line_items`.
 *
 * Verbose: prints exactly what it found, what it skipped, and any error,
 * one line per charge. Read the output to see where things break.
 *
 * Run from backend/:
 *   node test/manual/repair-line-items.js
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

// ─── Helpers ───────────────────────────────────────────────────────────────

async function rawStripe(pathStr, params = {}) {
  // Direct fetch — used for endpoints the SDK doesn't expose cleanly
  // (`invoice_payments` filtered by payment[*] keys).
  const url = new URL(`https://api.stripe.com/v1/${pathStr}`)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Stripe-Account': STRIPE_ACCT,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(`Stripe ${res.status}: ${body.error?.message ?? JSON.stringify(body)}`)
  }
  return body
}

async function findInvoiceForCharge(charge) {
  // 1. If charge.invoice is already set on the row in DB, use it.
  if (charge.invoice_id) return { invoiceId: charge.invoice_id, source: 'db' }

  // 2. Use the new bridge: invoice_payments filtered by payment_intent.
  const pi = charge.payment_intent_id
  if (!pi) return null
  const inpays = await rawStripe('invoice_payments', {
    'payment[type]': 'payment_intent',
    'payment[payment_intent]': pi,
    limit: '1',
  })
  const inv = inpays.data?.[0]?.invoice
  return inv ? { invoiceId: inv, source: 'invoice_payments' } : null
}

function mapInvoiceLines(invoice) {
  const out = []
  for (const l of invoice.lines?.data ?? []) {
    // New shape (current Stripe API):
    const pd = l.pricing?.price_details
    if (pd?.product) {
      out.push({
        id: l.id,
        product_id: pd.product,
        price_id: pd.price ?? null,
        amount: l.amount,
        quantity: l.quantity ?? null,
      })
      continue
    }
    // Old shape fallback (expanded price object):
    if (l.price && typeof l.price === 'object' && l.price.product) {
      out.push({
        id: l.id,
        product_id: l.price.product,
        price_id: l.price.id ?? null,
        amount: l.amount,
        quantity: l.quantity ?? null,
      })
    }
  }
  return out
}

async function repairChargeLineItems(charge) {
  const tag = `${charge.id}  ${(charge.amount / 100).toFixed(2)} ${charge.currency.toUpperCase()}`

  // Skip if line items already exist for this charge.
  const { count: existing } = await supabase
    .from('stripe_line_items')
    .select('*', { count: 'exact', head: true })
    .eq('charge_id', charge.id)
  if (existing && existing > 0) {
    console.log(`  ↺ ${tag}  already has ${existing} line item(s) — skipped`)
    return { skipped: true }
  }

  // Resolve invoice
  let resolved
  try {
    resolved = await findInvoiceForCharge(charge)
  } catch (err) {
    console.log(`  ✗ ${tag}  invoice lookup failed: ${err.message}`)
    return { error: err.message }
  }
  if (!resolved) {
    console.log(`  – ${tag}  no invoice (PI=${charge.payment_intent_id ?? '<none>'}) — skipped (would be unattributed)`)
    return { unattributed: true }
  }

  // Fetch invoice with proper expansion
  let invoice
  try {
    invoice = await stripe.invoices.retrieve(resolved.invoiceId)
  } catch (err) {
    console.log(`  ✗ ${tag}  invoice fetch ${resolved.invoiceId} failed: ${err.message}`)
    return { error: err.message }
  }

  // Map lines
  const items = mapInvoiceLines(invoice)
  if (items.length === 0) {
    const sample = invoice.lines?.data?.[0]
    console.log(
      `  ⚠ ${tag}  invoice=${resolved.invoiceId}  source=${resolved.source}  raw=${invoice.lines?.data?.length ?? 0}  mapped=0`,
    )
    if (sample) {
      console.log(`    sample line keys: ${Object.keys(sample).join(',')}`)
      console.log(`    sample.pricing  = ${JSON.stringify(sample.pricing)}`)
      console.log(`    sample.price    = ${JSON.stringify(sample.price)}`)
    }
    return { mapped: 0 }
  }

  // INSERT (delete-then-insert for idempotency)
  await supabase.from('stripe_line_items').delete().eq('charge_id', charge.id)
  const rows = items.map(i => ({
    id: i.id,
    charge_id: charge.id,
    stripe_account_id: STRIPE_ACCT,
    product_id: i.product_id,
    price_id: i.price_id,
    amount: i.amount,
    quantity: i.quantity,
  }))
  const { error: insErr } = await supabase.from('stripe_line_items').insert(rows)
  if (insErr) {
    console.log(`  ✗ ${tag}  insert failed: ${insErr.message}`)
    return { error: insErr.message }
  }

  // Also update the invoice_id on the charge so future runs / diagnostics see it.
  if (!charge.invoice_id) {
    await supabase
      .from('stripe_charges')
      .update({ invoice_id: resolved.invoiceId })
      .eq('id', charge.id)
  }

  const products = items.map(i => i.product_id).join(',')
  console.log(
    `  ✓ ${tag}  invoice=${resolved.invoiceId}  source=${resolved.source}  inserted=${items.length}  products=[${products}]`,
  )
  return { inserted: items.length }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n► repair-line-items  account=${STRIPE_ACCT}\n`)

  const { data: charges, error } = await supabase
    .from('stripe_charges')
    .select('id, amount, currency, status, payment_intent_id, invoice_id, customer_id')
    .eq('stripe_account_id', STRIPE_ACCT)
    .eq('status', 'succeeded')
    .order('created', { ascending: false })

  if (error) {
    console.error(`✗ failed to list charges: ${error.message}`)
    process.exit(1)
  }
  if (!charges || charges.length === 0) {
    console.log('(no charges in DB)')
    return
  }

  console.log(`Found ${charges.length} succeeded charge(s) for account.\n`)

  const totals = { repaired: 0, skipped: 0, errored: 0, unattributed: 0, mappedZero: 0 }
  for (const c of charges) {
    const res = await repairChargeLineItems(c)
    if (res.inserted) totals.repaired++
    else if (res.skipped) totals.skipped++
    else if (res.error) totals.errored++
    else if (res.unattributed) totals.unattributed++
    else if (res.mapped === 0) totals.mappedZero++
  }

  console.log('\n── summary ──')
  console.log(`  repaired      : ${totals.repaired}`)
  console.log(`  already had   : ${totals.skipped}`)
  console.log(`  unattributed  : ${totals.unattributed}`)
  console.log(`  mapped 0 lines: ${totals.mappedZero}`)
  console.log(`  errors        : ${totals.errored}`)

  // Final sanity: total line items in DB now
  const { count } = await supabase
    .from('stripe_line_items')
    .select('*', { count: 'exact', head: true })
    .eq('stripe_account_id', STRIPE_ACCT)
  console.log(`\n  stripe_line_items rows for account: ${count ?? 0}`)
}

main().catch(err => {
  console.error('\n✗', err.message)
  process.exit(1)
})
