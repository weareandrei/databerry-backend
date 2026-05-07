#!/usr/bin/env ts-node
/**
 * One-shot migration: walk every credential table in Supabase and
 * replace any plaintext columns with their encrypted (`v1:...`)
 * form, using the per-user encryption envelope defined in
 * `src/common/crypto/encryption.ts`.
 *
 * Idempotent: re-running is safe — `isEncrypted()` skips any column
 * already in `v1:` form. Means a partial run can be resumed by
 * just running again.
 *
 * Operational steps to run this:
 *   1. Set `ENCRYPTION_KEY` in `backend/.env` (or pass via env).
 *      Same value that production / Railway use; otherwise you'll
 *      encrypt with key A and prod can't decrypt.
 *   2. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (we need
 *      service-role to bypass RLS on the credential tables).
 *   3. From the backend directory:
 *        npx ts-node scripts/encrypt-existing-credentials.ts
 *   4. Run `verify-encrypted-credentials.ts` to confirm no
 *      plaintext rows remain.
 *
 * Output: one log line per modified row, plus a summary at the end.
 * Exits with code 0 on success, non-zero on any decrypt-roundtrip
 * failure (we re-decrypt every freshly-encrypted column to make
 * sure the migration didn't corrupt anything).
 */

import * as path from 'path'

// dotenv MUST run before the encryption module is imported — that
// module reads `process.env.ENCRYPTION_KEY` at import time and
// throws if missing.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
})

import { createClient } from '@supabase/supabase-js'
import { encryptForUser, decryptForUser, isEncrypted } from '../src/common/crypto/encryption'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * The set of (table, columns) pairs that hold sensitive credential
 * material. Configuration columns (`property_name`, `host`, etc.)
 * are intentionally not listed — those are identifiers, not auth
 * material. See `common/crypto/encryption.ts` for the design rationale.
 */
const TABLES: { table: string; columns: string[] }[] = [
  { table: 'connections_stripe',           columns: ['access_token', 'refresh_token'] },
  { table: 'connections_stripe_manual',    columns: ['api_key'] },
  { table: 'connections_calendly',         columns: ['access_token', 'refresh_token'] },
  { table: 'connections_google_analytics', columns: ['access_token', 'refresh_token'] },
  { table: 'connections_posthog',          columns: ['api_key'] },
  { table: 'connections_vercel',           columns: ['api_token'] },
]

async function migrate() {
  let totalRows = 0
  let totalEncrypted = 0
  let totalSkipped = 0
  let totalFailed = 0

  for (const { table, columns } of TABLES) {
    console.log(`\n► ${table} — columns=[${columns.join(', ')}]`)

    // Pull every row + the parent `connections.user_id` so we know
    // which key to derive. `inner` join — orphaned rows would
    // already be unusable, so skipping them is the right move.
    // Key off `connection_id` (always present, FK to `connections`)
    // rather than `id` — `connections_vercel` doesn't have an `id`
    // column, and using `connection_id` is consistent across every
    // credential table anyway.
    const selectCols = ['connection_id', ...columns, 'connections!inner(user_id)'].join(', ')
    const { data, error } = await client
      .from(table)
      .select(selectCols)

    if (error) {
      console.error(`  ✗ failed to list rows for ${table}: ${error.message}`)
      totalFailed++
      continue
    }
    if (!data || data.length === 0) {
      console.log(`  → no rows`)
      continue
    }

    for (const row of data as unknown as Array<Record<string, unknown>>) {
      totalRows++
      const conn = row.connections
      const userId = (Array.isArray(conn) ? conn[0] : conn) as { user_id?: string } | undefined
      const connectionId = row.connection_id as string
      if (!userId?.user_id) {
        console.warn(`  ⚠ skipped connection_id=${connectionId} — missing parent user_id`)
        totalSkipped++
        continue
      }
      const uid = userId.user_id

      const updates: Record<string, string> = {}
      for (const col of columns) {
        const raw = row[col]
        if (raw == null || raw === '') continue
        if (typeof raw !== 'string') continue
        if (isEncrypted(raw)) continue  // already migrated — idempotent skip

        // Encrypt + sanity-check: round-trip through decrypt to
        // confirm we wrote a valid blob. Catches a wrong-key /
        // wrong-userId scenario at write time rather than the next
        // time the credential is used.
        try {
          const encrypted = encryptForUser(raw, uid)
          const roundTrip = decryptForUser(encrypted, uid)
          if (roundTrip !== raw) {
            console.error(`  ✗ connection_id=${connectionId} col=${col}: round-trip mismatch`)
            totalFailed++
            continue
          }
          updates[col] = encrypted
        } catch (err) {
          console.error(`  ✗ connection_id=${connectionId} col=${col}: ${(err as Error).message}`)
          totalFailed++
          continue
        }
      }

      if (Object.keys(updates).length === 0) {
        totalSkipped++
        continue
      }

      const { error: updateErr } = await client
        .from(table)
        .update(updates)
        .eq('connection_id', connectionId)

      if (updateErr) {
        console.error(
          `  ✗ update failed for connection_id=${connectionId}: ${updateErr.message}`,
        )
        totalFailed++
        continue
      }

      totalEncrypted++
      console.log(
        `  ✓ connection_id=${connectionId} encrypted ${Object.keys(updates).length} col(s)`,
      )
    }
  }

  console.log(`\n────── summary ──────`)
  console.log(`rows seen:      ${totalRows}`)
  console.log(`rows encrypted: ${totalEncrypted}`)
  console.log(`rows skipped:   ${totalSkipped}`)
  console.log(`rows failed:    ${totalFailed}`)
  if (totalFailed > 0) {
    console.error('\nMigration completed with failures. Investigate before re-running.')
    process.exit(2)
  }
  console.log('\nMigration complete. Run verify-encrypted-credentials.ts to double-check.')
}

migrate().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
