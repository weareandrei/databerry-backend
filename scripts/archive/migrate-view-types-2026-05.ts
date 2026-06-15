#!/usr/bin/env ts-node
/**
 * One-shot migration: collapse the legacy `stripe_revenue_today` view
 * type into `stripe_gross` (the polymorphic successor) and stamp
 * `config.displayMode` on every row of the consolidated view types so
 * the renderer's dispatch-on-displayMode logic has a non-null value to
 * read.
 *
 * Why this exists:
 *   - We merged `stripe_revenue_today` (value) + `stripe_gross` (chart)
 *     into a single `stripe_gross` polymorphic on `config.displayMode`.
 *     Old `stripe_revenue_today` rows need to be renamed AND have
 *     `displayMode='value'` written, otherwise the new renderer would
 *     pick the chart branch (the safe default for unset displayMode).
 *   - We added chart-mode support for `daily_counter`, `ga_users_today`,
 *     `ga_sessions_today`, `ga_pageviews_today`. Existing rows of these
 *     types should keep their legacy value-mode behaviour, so we stamp
 *     `displayMode='value'` on every row that's missing it.
 *
 * Idempotent: re-running is safe — every UPDATE is gated by either the
 * old type name (which disappears on first run) or by a missing
 * `displayMode` (which is filled in on first run). A second run reports
 * 0 changes.
 *
 * Operational steps:
 *   1. From the backend directory:
 *        npx ts-node scripts/migrate-view-types-2026-05.ts
 *   2. Output: per-table change counts + a final summary.
 *   3. The script does NOT change anything if `--dry-run` is passed.
 *
 * Verification: after running, no row in `views` should have
 * `type = 'stripe_revenue_today'`, and no row of the consolidated
 * polymorphic types should have a missing `config.displayMode`. A SQL
 * one-liner is logged at the end for manual paste-into-Supabase
 * verification.
 */

import * as path from 'path'

// dotenv MUST run before reading env, mirrors the
// encrypt-existing-credentials.ts script.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface ViewRow {
  id: string
  type: string
  config: Record<string, unknown> | null
}

/**
 * Pull every row whose `type` is in the supplied set, with current
 * `config`. We do the rewrite in JS (not in raw SQL `jsonb_set`) so the
 * script is identical against any Postgres / Supabase variant —
 * supabase-js's `.update()` happily handles nested JSON.
 */
async function listRows(types: string[]): Promise<ViewRow[]> {
  const { data, error } = await client
    .from('views')
    .select('id, type, config')
    .in('type', types)
  if (error) {
    console.error(`  ✗ failed to list rows for types=[${types.join(', ')}]: ${error.message}`)
    return []
  }
  return (data ?? []) as ViewRow[]
}

async function updateRow(
  id: string,
  patch: { type?: string; config: Record<string, unknown> },
): Promise<boolean> {
  if (dryRun) return true
  const { error } = await client.from('views').update(patch).eq('id', id)
  if (error) {
    console.error(`  ✗ update failed for id=${id}: ${error.message}`)
    return false
  }
  return true
}

interface TaskResult {
  scanned: number
  changed: number
  failed: number
}

/**
 * Step 1 — `stripe_revenue_today` rows are renamed to `stripe_gross`
 * and stamped with `displayMode='value'`. Idempotent because once
 * renamed, the row no longer matches the input filter.
 */
async function migrateStripeRevenueToday(): Promise<TaskResult> {
  console.log(`\n► step 1: stripe_revenue_today → stripe_gross + displayMode='value'`)
  const rows = await listRows(['stripe_revenue_today'])
  console.log(`  → ${rows.length} row(s) to migrate`)
  let changed = 0
  let failed = 0
  for (const row of rows) {
    const newConfig = { ...(row.config ?? {}), displayMode: 'value' }
    const ok = await updateRow(row.id, { type: 'stripe_gross', config: newConfig })
    if (ok) {
      changed++
      console.log(`  ✓ id=${row.id} renamed to stripe_gross + displayMode='value'`)
    } else {
      failed++
    }
  }
  return { scanned: rows.length, changed, failed }
}

/**
 * Step 2 — every existing `stripe_gross` row that lacks
 * `config.displayMode` gets stamped with `'chart'`. This preserves the
 * legacy chart-mode behaviour for pre-migration `stripe_gross` rows
 * (the renderer's default-chart fallback would also work, but stamping
 * makes the row's intent explicit and stable).
 */
async function stampDisplayModeFor(
  type: string,
  defaultMode: 'chart' | 'value',
): Promise<TaskResult> {
  console.log(`\n► step: ${type} — stamp displayMode='${defaultMode}' if missing`)
  const rows = await listRows([type])
  console.log(`  → ${rows.length} row(s) of type=${type}`)
  let changed = 0
  let failed = 0
  for (const row of rows) {
    const cfg = row.config ?? {}
    if (typeof cfg.displayMode === 'string') continue // already stamped
    const newConfig = { ...cfg, displayMode: defaultMode }
    const ok = await updateRow(row.id, { config: newConfig })
    if (ok) {
      changed++
      console.log(`  ✓ id=${row.id} stamped displayMode='${defaultMode}'`)
    } else {
      failed++
    }
  }
  return { scanned: rows.length, changed, failed }
}

async function main() {
  if (dryRun) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('DRY RUN — no UPDATE statements will be executed.')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  const stripeRename = await migrateStripeRevenueToday()
  // After step 1, freshly-renamed rows already have displayMode='value'.
  // Step 2 picks up the *original* stripe_gross rows that have always
  // been chart-mode and stamps them.
  const stripeChartStamp = await stampDisplayModeFor('stripe_gross', 'chart')
  const dailyCounterStamp = await stampDisplayModeFor('daily_counter', 'value')
  const gaUsersStamp = await stampDisplayModeFor('ga_users_today', 'value')
  const gaSessionsStamp = await stampDisplayModeFor('ga_sessions_today', 'value')
  const gaPageviewsStamp = await stampDisplayModeFor('ga_pageviews_today', 'value')

  const tasks = [
    ['stripe_revenue_today → stripe_gross', stripeRename],
    ['stripe_gross stamp', stripeChartStamp],
    ['daily_counter stamp', dailyCounterStamp],
    ['ga_users_today stamp', gaUsersStamp],
    ['ga_sessions_today stamp', gaSessionsStamp],
    ['ga_pageviews_today stamp', gaPageviewsStamp],
  ] as const

  console.log(`\n────── summary ──────`)
  let totalChanged = 0
  let totalFailed = 0
  for (const [label, t] of tasks) {
    console.log(
      `${label.padEnd(38)}  scanned=${t.scanned}  changed=${t.changed}  failed=${t.failed}`,
    )
    totalChanged += t.changed
    totalFailed += t.failed
  }
  console.log(`${'TOTAL'.padEnd(38)}  changed=${totalChanged}  failed=${totalFailed}`)

  if (totalFailed > 0) {
    console.error('\nMigration completed with failures. Investigate before re-running.')
    process.exit(2)
  }

  console.log(`
Verification (paste in Supabase SQL editor):

  -- expect 0
  SELECT count(*) FROM views WHERE type = 'stripe_revenue_today';

  -- expect 0
  SELECT count(*) FROM views
   WHERE type IN ('stripe_gross', 'daily_counter',
                  'ga_users_today', 'ga_sessions_today',
                  'ga_pageviews_today')
     AND (config->>'displayMode') IS NULL;
`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
