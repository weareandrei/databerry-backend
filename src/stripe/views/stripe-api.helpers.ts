import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'

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

  if (!conn) throw new NotFoundException('Connection not found')

  const { data } = await supabaseService
    .getClient()
    .from('connections_stripe_manual')
    .select('api_key')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (!data) throw new NotFoundException('Stripe manual credentials not found')
  return data.api_key as string
}

/** Returns an authenticated fetch function for the Stripe API. */
export function makeStripeGetter(apiKey: string): StripeGetter {
  return async (path: string, params?: Record<string, string>) => {
    const url = new URL(`https://api.stripe.com/v1/${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      const msg = (body?.error as Record<string, unknown>)?.message as string | undefined
      throw new UnauthorizedException(msg ?? `Stripe API error ${res.status}`)
    }
    return res.json() as Promise<Record<string, unknown>>
  }
}

/** Fetches the Stripe manual API key for a connection without user ownership check (for internal/scheduler use). */
export async function getApiKeyInternal(
  connectionId: string,
  supabaseService: SupabaseService,
): Promise<string> {
  const { data } = await supabaseService
    .getClient()
    .from('connections_stripe_manual')
    .select('api_key')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (!data) throw new Error('Stripe manual credentials not found')
  return data.api_key as string
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
