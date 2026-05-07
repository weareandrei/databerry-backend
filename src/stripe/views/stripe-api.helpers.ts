import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ConnectionMissingException } from '../../common/integration-errors'
import { decryptForUser, isEncrypted } from '../../common/crypto/encryption'

// Single shared logger for every Stripe HTTP call. Tagged so it's easy to
// grep for: `[StripeAPI]`. Every request and every failure gets one line.
const stripeApiLogger = new Logger('StripeAPI')

export interface ChartPoint {
  label: string
  value: number // cents
}

export type StripeGetter = (
  path: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>

interface StripeChargePage {
  data: { id: string; status: string; amount: number; created: number }[]
  has_more: boolean
}

/** Retrieves the Stripe manual API key for a connection, verifying ownership. */
export async function getApiKey(
  connectionId: string,
  userId: string,
  supabaseService: SupabaseService,
): Promise<string> {
  const { data: conn } = await supabaseService
    .getClient()
    .from('connections')
    .select('id')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle()

  // 410 → frontend renders an inline reattach prompt on the affected tile
  // instead of a generic fetch-failed badge.
  if (!conn) throw new ConnectionMissingException('stripe_manual', connectionId)

  const { data } = await supabaseService
    .getClient()
    .from('connections_stripe_manual')
    .select('api_key')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (!data) throw new NotFoundException('Stripe manual credentials not found')

  // Decrypt-on-read with plaintext fallback for pre-migration rows.
  // `userId` is in scope from the ownership check above.
  const raw = data.api_key as string
  return isEncrypted(raw) ? decryptForUser(raw, userId) : raw
}

/**
 * Returns an authenticated fetch function for the Stripe API.
 *
 * Logs every call: method+path, params (without the API key), HTTP status,
 * and a one-line summary of the body (item count + has_more for list
 * responses). On error, logs the full Stripe error code + message before
 * throwing — those are the breadcrumbs we need when "the picker is empty"
 * but no exception ever bubbled to the user.
 */
export function makeStripeGetter(apiKey: string): StripeGetter {
  // Mask the key in logs: `rk_test_***abc`. Enough to disambiguate which key
  // a request used during multi-account debugging without leaking secrets.
  const keyTag = apiKey.length >= 8
    ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`
    : '<short-key>'

  return async (path: string, params?: Record<string, string>) => {
    const url = new URL(`https://api.stripe.com/v1/${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    }
    const paramsTag = params
      ? Object.entries(params)
          .filter(([k]) => k !== 'starting_after') // noisy + always changing
          .map(([k, v]) => `${k}=${v}`)
          .join('&')
      : ''

    const startedAt = Date.now()
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const elapsed = Date.now() - startedAt

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      const err = (body?.error ?? {}) as Record<string, unknown>
      const msg = (err.message as string | undefined) ?? `Stripe API error ${res.status}`
      const code = (err.code as string | undefined) ?? ''
      const type = (err.type as string | undefined) ?? ''
      stripeApiLogger.error(
        `✗ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${keyTag}  status=${res.status}  ` +
          `type=${type}  code=${code}  msg="${msg}"  (${elapsed}ms)`,
      )
      // 401/403 → scope/key issue. Anything else is a real Stripe outage and
      // the caller should see it as a generic error, not "Unauthorized".
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(msg)
      }
      throw new Error(`Stripe ${res.status}: ${msg}`)
    }

    const body = (await res.json()) as Record<string, unknown>
    // List responses have `data` array + `has_more`. Single-resource
    // responses (e.g. `/account`) don't — fall through to a generic line.
    const data = body.data
    if (Array.isArray(data)) {
      const hasMore = body.has_more === true
      stripeApiLogger.log(
        `✓ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${keyTag}  ` +
          `items=${data.length}  has_more=${hasMore}  (${elapsed}ms)`,
      )
    } else {
      const id = (body.id as string | undefined) ?? '<no-id>'
      stripeApiLogger.log(
        `✓ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${keyTag}  id=${id}  (${elapsed}ms)`,
      )
    }
    return body
  }
}

/** Fetches the Stripe manual API key for a connection without user ownership check (for internal/scheduler use). */
export async function getApiKeyInternal(
  connectionId: string,
  supabaseService: SupabaseService,
): Promise<string> {
  // Pull `user_id` via a join so we can derive the per-user
  // decryption key — internal callers (scheduler / sync) don't have
  // a `userId` in scope. The credential row's owning connection
  // always has one.
  const { data } = await supabaseService
    .getClient()
    .from('connections_stripe_manual')
    .select('api_key, connections!inner(user_id)')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (!data) throw new Error('Stripe manual credentials not found')

  const userId = (
    Array.isArray(data.connections) ? data.connections[0] : data.connections
  )?.user_id as string | undefined
  if (!userId) {
    throw new Error('Stripe manual credentials orphaned (no user_id)')
  }

  const raw = data.api_key as string
  return isEncrypted(raw) ? decryptForUser(raw, userId) : raw
}

/** Paginates through Stripe charges from `createdGte` (optionally up to `createdLt`) and returns the total sum in cents. */
export async function sumCharges(get: StripeGetter, createdGte: number, createdLt?: number): Promise<string> {
  let total = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params: Record<string, string> = {
      'created[gte]': String(createdGte),
      limit: '100',
    }
    if (createdLt !== undefined) params['created[lt]'] = String(createdLt)
    if (startingAfter) params['starting_after'] = startingAfter

    const data = (await get('charges', params)) as unknown as StripeChargePage

    for (const c of data.data) {
      if (c.status === 'succeeded') total += c.amount
    }

    hasMore = data.has_more
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id
    }
  }

  return String(total)
}

/** Paginates through Stripe charges from `createdGte` (optionally up to `createdLt`) and returns the raw list. */
export async function fetchChargesSince(
  get: StripeGetter,
  createdGte: number,
  createdLt?: number,
): Promise<{ created: number; amount: number; status: string }[]> {
  const all: { created: number; amount: number; status: string }[] = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params: Record<string, string> = {
      'created[gte]': String(createdGte),
      limit: '100',
    }
    if (createdLt !== undefined) params['created[lt]'] = String(createdLt)
    if (startingAfter) params['starting_after'] = startingAfter

    const data = (await get('charges', params)) as unknown as StripeChargePage

    for (const c of data.data) {
      all.push({ created: c.created, amount: c.amount, status: c.status })
    }

    hasMore = data.has_more
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id
    }
  }

  return all
}
