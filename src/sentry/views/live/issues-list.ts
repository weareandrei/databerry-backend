import { Logger } from '@nestjs/common'
import {
  IntegrationReauthRequiredException,
  IntegrationUpstreamException,
} from '../../../common/integration-errors'

const BASE_API = 'https://sentry.io/api/0'

/**
 * Wire shape for one entry returned by the issues-list view —
 * curated subset of Sentry's `/organizations/{org}/issues/` payload.
 * Frontend renders these in a list tile so we only ship the fields
 * actually displayed: title, count, `firstSeen` / `lastSeen`, status,
 * level (error / warning / info), permalink for "open in Sentry".
 *
 * Sentry's response also contains `assignedTo`, `culprit`, full
 * `stats` arrays etc. — none of which the MVP view uses, so we trim
 * them out at this layer to keep the payload small.
 */
export interface SentryIssue {
  id: string
  /** Human-readable error title, e.g. `TypeError: Cannot read properties of undefined`. */
  title: string
  /** Number of events for this issue inside `statsPeriod`, as a string
   *  (Sentry returns it stringified — we keep that to avoid losing
   *  precision on huge counts). */
  count: string
  level: 'error' | 'warning' | 'info' | 'debug' | 'fatal' | string
  status: 'unresolved' | 'resolved' | 'ignored' | string
  firstSeen: string
  lastSeen: string
  /** Direct URL into Sentry — e.g. `https://sentry.io/organizations/foo/issues/123/`. */
  permalink: string
}

/**
 * Sort + period filter shape — these flow straight to Sentry's
 * `/issues/` query params with a tiny mapping (our `recent` →
 * Sentry's `new`, our `frequent` → Sentry's `freq`). Period values
 * are passed verbatim to `statsPeriod` (Sentry accepts e.g. `24h`,
 * `7d`, `30d`).
 */
export type IssuesPeriod = '24h' | '7d' | '30d' | '90d'
export type IssuesSort = 'recent' | 'frequent'

/**
 * Pull the issues list for an org. `statsPeriod` filters events
 * inside that window (Sentry rolls counts up automatically).
 *
 * Default `query=is:unresolved` because resolved issues clutter the
 * list and the MVP user is asking "what's broken right now". Caller
 * can extend by tacking extra clauses onto the query string.
 *
 * Sentry caps page size at 100 — we only ask for `limit=25` because
 * the list tile renders ~10–15 visible rows comfortably and pagination
 * is out of MVP scope.
 */
export async function fetchIssuesList(
  token: string,
  connectionId: string,
  orgSlug: string,
  logger: Logger,
  period: IssuesPeriod = '24h',
  sort: IssuesSort = 'recent',
): Promise<SentryIssue[]> {
  const sentrySort = sort === 'frequent' ? 'freq' : 'new'

  const url = new URL(`${BASE_API}/organizations/${orgSlug}/issues/`)
  url.searchParams.set('statsPeriod', period)
  url.searchParams.set('sort', sentrySort)
  url.searchParams.set('limit', '25')
  url.searchParams.set('query', 'is:unresolved')

  let res: Response
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    logger.warn(`Sentry issues fetch network error for ${connectionId}: ${String(err)}`)
    throw new IntegrationUpstreamException(
      'sentry',
      connectionId,
      'Could not reach Sentry API',
    )
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // 401/403 → token is bad / scope was revoked → surface reauth
    // (same convention GA + Calendly use). Anything else → upstream.
    if (res.status === 401 || res.status === 403) {
      logger.warn(
        `Sentry issues 401/403 for ${connectionId}: ${detail.slice(0, 200)}`,
      )
      throw new IntegrationReauthRequiredException(
        'sentry',
        connectionId,
        `Sentry API ${res.status}: ${detail.slice(0, 200)}`,
      )
    }
    logger.warn(
      `Sentry issues upstream ${res.status} for ${connectionId}: ${detail.slice(0, 200)}`,
    )
    throw new IntegrationUpstreamException(
      'sentry',
      connectionId,
      `Sentry API ${res.status}`,
    )
  }

  // Sentry's payload is an array. Each entry has many fields; pluck
  // only what the view renders.
  const raw = (await res.json()) as Array<{
    id: string
    title: string
    count: string
    level: string
    status: string
    firstSeen: string
    lastSeen: string
    permalink: string
  }>

  return raw.map(r => ({
    id: r.id,
    title: r.title,
    count: r.count,
    level: r.level,
    status: r.status,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    permalink: r.permalink,
  }))
}
