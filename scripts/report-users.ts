#!/usr/bin/env ts-node
/**
 * Read-only inventory of every user and what they've built. Prints, per
 * user, an indented tree:
 *
 *   USER  <email>
 *     PROJECTS (n)
 *       <project name>  —  <#views> views  —  created <date>
 *         VIEWS (n)
 *           <created date>  <type>
 *     CONNECTIONS (n)
 *       <name>  <type>  [Common | project: <name>]  created <date>
 *
 * Purely diagnostic — issues only SELECTs (plus the auth admin
 * listUsers call). Nothing is written or mutated.
 *
 * Run from the backend directory under Node 20+ (the default `node`
 * here is v16, which lacks the global `Headers` that supabase-js
 * needs — it'll crash with "Headers is not defined" otherwise):
 *   nvm use 20 && npx ts-node scripts/report-users.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env
 * (the service-role key is needed for `auth.admin.listUsers`).
 */

import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
})

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Row shapes (only the columns this report reads) ───────────────────────
interface ProjectRow {
  id: string
  name: string
  user_id: string
  created_at: string
}
interface ViewRow {
  id: string
  name: string | null
  type: string
  project_id: string | null
  user_id: string
  created_at: string
}
interface ConnectionRow {
  id: string
  name: string
  type: string
  project_id: string | null
  user_id: string
  created_at: string
}

// ── Formatting helpers ────────────────────────────────────────────────────

const I = '  ' // one indent step (2 spaces)
function indent(level: number): string {
  return I.repeat(level)
}

/** "2026-01-06 14:30" — compact, sortable, no timezone noise. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

/** Whole days between two ISO timestamps, or null if either is missing. */
function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const da = new Date(a).getTime()
  const db = new Date(b).getTime()
  if (Number.isNaN(da) || Number.isNaN(db)) return null
  return Math.round(Math.abs(db - da) / 86_400_000)
}

/** Earliest + latest ISO timestamp in a list, or nulls when empty. */
function span(isos: string[]): { first: string | null; last: string | null } {
  if (isos.length === 0) return { first: null, last: null }
  const sorted = [...isos].sort()
  return { first: sorted[0], last: sorted[sorted.length - 1] }
}

/** Right-pad to `width` for column alignment (never truncates). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

// ── Bulk fetch + in-memory grouping ───────────────────────────────────────
//
// One SELECT per table, then group locally — cheaper and simpler than a
// query-per-user fan-out, and the row counts here are tiny.

interface AuthUser {
  id: string
  email: string | null
  created_at: string
  // GoTrue's admin API returns ONLY the most recent sign-in here — not a
  // full history. A complete per-login list lives in `auth.audit_log_entries`
  // (not reachable via this REST client — the `auth` schema isn't exposed)
  // or in PostHog's `logged_in` events. See the script header / the answer
  // for how to pull the full history.
  last_sign_in_at: string | null
}

async function listAllUsers(): Promise<AuthUser[]> {
  const all: AuthUser[] = []
  // `listUsers` paginates; walk pages until a short page signals the end.
  const perPage = 1000
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    for (const u of data.users) {
      all.push({
        id: u.id,
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
      })
    }
    if (data.users.length < perPage) break
  }
  return all
}

async function fetchTable<T>(table: string, columns: string): Promise<T[]> {
  const { data, error } = await client
    .from(table)
    .select(columns)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`select ${table} failed: ${error.message}`)
  return (data ?? []) as unknown as T[]
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    if (k == null) continue
    const bucket = map.get(k)
    if (bucket) bucket.push(row)
    else map.set(k, [row])
  }
  return map
}

async function main() {
  const [users, projects, views, connections] = await Promise.all([
    listAllUsers(),
    fetchTable<ProjectRow>('projects', 'id, name, user_id, created_at'),
    fetchTable<ViewRow>('views', 'id, name, type, project_id, user_id, created_at'),
    fetchTable<ConnectionRow>(
      'connections',
      'id, name, type, project_id, user_id, created_at',
    ),
  ])

  // Sort users oldest-first so the report reads chronologically.
  users.sort((a, b) => a.created_at.localeCompare(b.created_at))

  const projectsByUser = groupBy(projects, p => p.user_id)
  const viewsByProject = groupBy(views, v => v.project_id)
  const connectionsByUser = groupBy(connections, c => c.user_id)
  // project id → name, for labelling project-scoped connections.
  const projectName = new Map(projects.map(p => [p.id, p.name]))

  console.log(
    `\n${'='.repeat(72)}\n` +
      `DATABERRY USER REPORT — ${users.length} user(s), ${projects.length} project(s), ` +
      `${views.length} view(s), ${connections.length} connection(s)\n` +
      `generated ${fmtDate(new Date().toISOString())}\n` +
      `${'='.repeat(72)}`,
  )

  // For the "how long were they interested" line we need every view that
  // belongs to a user, not just the ones nested under their projects.
  const viewsByUser = groupBy(views, v => v.user_id)

  for (const user of users) {
    const userProjects = projectsByUser.get(user.id) ?? []
    const userConnections = connectionsByUser.get(user.id) ?? []
    const userViews = viewsByUser.get(user.id) ?? []

    // "Interest span" — two complementary signals:
    //   • signup → last sign-in: how long they kept coming BACK (auth).
    //     `last_sign_in_at` is the MOST RECENT login only; full per-login
    //     dates aren't available here (see AuthUser docstring).
    //   • build activity window: first → last thing they CREATED across
    //     projects/views/connections — a proxy for their active period
    //     that doesn't depend on the auth audit log.
    const loginSpanDays = daysBetween(user.created_at, user.last_sign_in_at)
    const activity = span([
      ...userProjects.map(p => p.created_at),
      ...userViews.map(v => v.created_at),
      ...userConnections.map(c => c.created_at),
    ])
    const activitySpanDays = daysBetween(activity.first, activity.last)

    console.log(`\n${'─'.repeat(72)}`)
    console.log(`USER  ${user.email ?? '(no email)'}`)
    console.log(`${indent(1)}id: ${user.id}`)
    console.log(
      `${indent(1)}signed up: ${fmtDate(user.created_at)}   ` +
        `last sign-in: ${fmtDate(user.last_sign_in_at)}` +
        (loginSpanDays != null ? `   (kept returning ~${loginSpanDays}d)` : ''),
    )
    console.log(
      `${indent(1)}build activity: ${fmtDate(activity.first)} → ${fmtDate(activity.last)}` +
        (activitySpanDays != null ? `   (~${activitySpanDays}d active)` : ' (no activity)'),
    )

    // ── Projects (with their views nested underneath) ──────────────────
    console.log(`${indent(1)}PROJECTS (${userProjects.length}):`)
    if (userProjects.length === 0) {
      console.log(`${indent(2)}(none)`)
    }
    for (const project of userProjects) {
      const projectViews = viewsByProject.get(project.id) ?? []
      console.log(
        `${indent(2)}• ${project.name}  —  ${projectViews.length} view(s)  —  ` +
          `created ${fmtDate(project.created_at)}`,
      )
      console.log(`${indent(3)}VIEWS (${projectViews.length}):`)
      if (projectViews.length === 0) {
        console.log(`${indent(4)}(none)`)
      }
      for (const view of projectViews) {
        console.log(
          `${indent(4)}- ${pad(fmtDate(view.created_at), 18)} ${view.type}`,
        )
      }
    }

    // ── Connections (user-scoped; note Common vs per-project) ──────────
    console.log(`${indent(1)}CONNECTIONS (${userConnections.length}):`)
    if (userConnections.length === 0) {
      console.log(`${indent(2)}(none)`)
    }
    for (const conn of userConnections) {
      const scope =
        conn.project_id == null
          ? 'Common'
          : `project: ${projectName.get(conn.project_id) ?? conn.project_id}`
      console.log(
        `${indent(2)}- ${pad(conn.name, 24)} ${pad(conn.type, 18)} ` +
          `[${pad(scope, 26)}] created ${fmtDate(conn.created_at)}`,
      )
    }
  }

  console.log(`\n${'='.repeat(72)}\n`)
}

main().catch(err => {
  console.error('\n✗ report failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
