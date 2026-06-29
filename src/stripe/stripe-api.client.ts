import { Logger, UnauthorizedException } from '@nestjs/common'

const stripeApiLogger = new Logger('StripeAPI')

/**
 * Authenticated HTTP client for a user's Stripe account (manual API key or
 * Connect access token). One instance per credential — never a singleton.
 */
export class StripeApiClient {
  private readonly credentialTag: string

  constructor(private readonly credential: string) {
    this.credentialTag =
      credential.length >= 8
        ? `${credential.slice(0, 8)}…${credential.slice(-4)}`
        : '<short-key>'
  }

  /**
   * GET https://api.stripe.com/v1/{path} with Bearer auth.
   */
  async get(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`https://api.stripe.com/v1/${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }

    const paramsTag = params
      ? Object.entries(params)
          .filter(([key]) => key !== 'starting_after')
          .map(([key, value]) => `${key}=${value}`)
          .join('&')
      : ''

    const startedAt = Date.now()
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.credential}` },
    })
    const elapsed = Date.now() - startedAt

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const error = (body?.error ?? {}) as Record<string, unknown>
      const message =
        (error.message as string | undefined) ?? `Stripe API error ${response.status}`
      const code = (error.code as string | undefined) ?? ''
      const type = (error.type as string | undefined) ?? ''
      stripeApiLogger.error(
        `✗ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${this.credentialTag}  status=${response.status}  ` +
          `type=${type}  code=${code}  msg="${message}"  (${elapsed}ms)`,
      )
      if (response.status === 401 || response.status === 403) {
        throw new UnauthorizedException(message)
      }
      throw new Error(`Stripe ${response.status}: ${message}`)
    }

    const body = (await response.json()) as Record<string, unknown>
    const data = body.data
    if (Array.isArray(data)) {
      stripeApiLogger.log(
        `✓ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${this.credentialTag}  ` +
          `items=${data.length}  has_more=${body.has_more === true}  (${elapsed}ms)`,
      )
    } else {
      const id = (body.id as string | undefined) ?? '<no-id>'
      stripeApiLogger.log(
        `✓ GET /${path}${paramsTag ? `?${paramsTag}` : ''}  key=${this.credentialTag}  id=${id}  (${elapsed}ms)`,
      )
    }

    return body
  }
}

interface StripeChargePage {
  data: { id: string; status: string; amount: number; created: number }[]
  has_more: boolean
}

/** Paginate charges and sum succeeded amounts (cents). */
export async function sumCharges(
  client: StripeApiClient,
  createdGte: number,
  createdLt?: number,
): Promise<string> {
  let total = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params: Record<string, string> = {
      'created[gte]': String(createdGte),
      limit: '100',
    }
    if (createdLt !== undefined) params['created[lt]'] = String(createdLt)
    if (startingAfter) params.starting_after = startingAfter

    const page = (await client.get('charges', params)) as unknown as StripeChargePage

    for (const charge of page.data) {
      if (charge.status === 'succeeded') total += charge.amount
    }

    hasMore = page.has_more
    if (hasMore && page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  return String(total)
}

/** Paginate charges and return raw rows. */
export async function fetchChargesSince(
  client: StripeApiClient,
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
    if (startingAfter) params.starting_after = startingAfter

    const page = (await client.get('charges', params)) as unknown as StripeChargePage

    for (const charge of page.data) {
      all.push({ created: charge.created, amount: charge.amount, status: charge.status })
    }

    hasMore = page.has_more
    if (hasMore && page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  return all
}
