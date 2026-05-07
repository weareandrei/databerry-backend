#!/usr/bin/env ts-node
/**
 * Sanity check after running `encrypt-existing-credentials.ts`.
 * Walks every credential table and counts rows where a sensitive
 * column is non-null but doesn't have the `v1:` prefix — i.e.
 * still plaintext.
 *
 * Exits 0 if every row is encrypted. Exits 2 if any plaintext rows
 * remain (and prints their IDs so you can investigate).
 *
 * Run from the backend directory:
 *   npx ts-node scripts/verify-encrypted-credentials.ts
 */

import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
})

import { createClient } from '@supabase/supabase-js'
import { isEncrypted } from '../src/common/crypto/encryption'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TABLES: { table: string; columns: string[] }[] = [
  { table: 'connections_stripe',           columns: ['access_token', 'refresh_token'] },
  { table: 'connections_stripe_manual',    columns: ['api_key'] },
  { table: 'connections_calendly',         columns: ['access_token', 'refresh_token'] },
  { table: 'connections_google_analytics', columns: ['access_token', 'refresh_token'] },
  { table: 'connections_posthog',          columns: ['api_key'] },
  { table: 'connections_vercel',           columns: ['api_token'] },
]

interface Offender {
  table: string
  connectionId: string
  column: string
  preview: string
}

async function verify(): Promise<Offender[]> {
  const offenders: Offender[] = []

  for (const { table, columns } of TABLES) {
    // Key off `connection_id` — always present, consistent across all
    // credential tables. `connections_vercel` doesn't have an `id`
    // column at all.
    const selectCols = ['connection_id', ...columns].join(', ')
    const { data, error } = await client
      .from(table)
      .select(selectCols)

    if (error) {
      console.error(`✗ failed to list rows for ${table}: ${error.message}`)
      offenders.push({
        table,
        connectionId: '<query failed>',
        column: '*',
        preview: error.message,
      })
      continue
    }
    if (!data) continue

    for (const row of data as unknown as Array<Record<string, unknown>>) {
      for (const col of columns) {
        const raw = row[col]
        if (raw == null || raw === '') continue
        if (typeof raw !== 'string') continue
        if (!isEncrypted(raw)) {
          offenders.push({
            table,
            connectionId: row.connection_id as string,
            column: col,
            // Don't print the actual plaintext credential — just
            // enough to recognise it. First 4 chars + "…".
            preview: raw.slice(0, 4) + '…',
          })
        }
      }
    }
  }

  return offenders
}

verify()
  .then(offenders => {
    if (offenders.length === 0) {
      console.log('✓ All sensitive credential columns are encrypted (v1:).')
      process.exit(0)
    }
    console.error(`\n✗ Found ${offenders.length} plaintext column(s):`)
    for (const o of offenders) {
      console.error(
        `  • ${o.table}  connection_id=${o.connectionId}  column=${o.column}  preview="${o.preview}"`,
      )
    }
    console.error(
      '\nRun `encrypt-existing-credentials.ts` to migrate them, then re-run this verifier.',
    )
    process.exit(2)
  })
  .catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
