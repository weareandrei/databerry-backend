import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

export interface ChartPoint {
  label: string
  value: number // cents
}

type StripeGetter = (
  path: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>

@Injectable()
export class StripeManualService {
  private readonly logger = new Logger(StripeManualService.name)

  constructor(private readonly supabaseService: SupabaseService) {}

  // ── Public ────────────────────────────────────────────────────────────────

  async fetchLiveValue(connectionId: string, viewType: string, userId: string): Promise<string> {
    this.logger.log(`\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}`)
    const apiKey = await this.getApiKey(connectionId, userId)
    const get = this.makeStripeGetter(apiKey)
    const value = await this.computeLiveValue(get, viewType)
    await this.upsertValue(connectionId, viewType, value)
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return value
  }

  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
  ): Promise<ChartPoint[]> {
    this.logger.log(`\n  ► fetchChartData  connectionId=${connectionId}  viewType=${viewType}`)
    const apiKey = await this.getApiKey(connectionId, userId)
    const get = this.makeStripeGetter(apiKey)

    switch (viewType) {
      case 'stripe_gross_today':
        return this.chartToday(get)
      case 'stripe_gross_week':
        return this.chartWeek(get)
      default:
        throw new NotFoundException(`No chart data for view type: ${viewType}`)
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async getApiKey(connectionId: string, userId: string): Promise<string> {
    const { data: conn } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!conn) throw new NotFoundException('Connection not found')

    const { data } = await this.supabaseService
      .getClient()
      .from('connections_stripe_manual')
      .select('api_key')
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (!data) throw new NotFoundException('Stripe manual credentials not found')
    return data.api_key as string
  }

  private makeStripeGetter(apiKey: string): StripeGetter {
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

  private async computeLiveValue(get: StripeGetter, viewType: string): Promise<string> {
    const todayUnix = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000)

    switch (viewType) {
      case 'stripe_gross_today':
      case 'stripe_revenue_today':
        return this.sumCharges(get, todayUnix)

      case 'stripe_gross_week': {
        const now = new Date()
        const day = now.getUTCDay()
        const daysSinceMonday = day === 0 ? 6 : day - 1
        const monday = new Date(now)
        monday.setUTCDate(now.getUTCDate() - daysSinceMonday)
        monday.setUTCHours(0, 0, 0, 0)
        return this.sumCharges(get, Math.floor(monday.getTime() / 1000))
      }

      default:
        throw new NotFoundException(`Unknown view type: ${viewType}`)
    }
  }

  // Fetch all charges from `createdGte` onwards, return sum in cents
  private async sumCharges(get: StripeGetter, createdGte: number): Promise<string> {
    let total = 0
    let hasMore = true
    let startingAfter: string | undefined

    while (hasMore) {
      const params: Record<string, string> = {
        'created[gte]': String(createdGte),
        limit: '100',
      }
      if (startingAfter) params['starting_after'] = startingAfter

      const data = (await get('charges', params)) as {
        data: { id: string; status: string; amount: number }[]
        has_more: boolean
      }

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

  // Fetch all charges from `createdGte`, return raw list
  private async fetchChargesSince(
    get: StripeGetter,
    createdGte: number,
  ): Promise<{ created: number; amount: number; status: string }[]> {
    const all: { created: number; amount: number; status: string }[] = []
    let hasMore = true
    let startingAfter: string | undefined

    while (hasMore) {
      const params: Record<string, string> = {
        'created[gte]': String(createdGte),
        limit: '100',
      }
      if (startingAfter) params['starting_after'] = startingAfter

      const data = (await get('charges', params)) as {
        data: { id: string; status: string; amount: number; created: number }[]
        has_more: boolean
      }

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

  // ── Chart builders ────────────────────────────────────────────────────────

  // Today: hourly buckets 0..currentHour, label "12am", "1am" …
  private async chartToday(get: StripeGetter): Promise<ChartPoint[]> {
    const now = new Date()
    const todayUnix = Math.floor(now.setUTCHours(0, 0, 0, 0) / 1000)
    const currentHour = new Date().getUTCHours()

    const charges = await this.fetchChargesSince(get, todayUnix)

    // Bucket by UTC hour
    const buckets: number[] = new Array(currentHour + 1).fill(0)
    for (const c of charges) {
      if (c.status !== 'succeeded') continue
      const hour = new Date(c.created * 1000).getUTCHours()
      if (hour <= currentHour) buckets[hour] += c.amount
    }

    const fmtHour = (h: number) => {
      if (h === 0) return '12am'
      if (h < 12) return `${h}am`
      if (h === 12) return '12pm'
      return `${h - 12}pm`
    }

    return buckets.map((value, h) => ({ label: fmtHour(h), value }))
  }

  // Week: daily buckets Mon..today, label "Mon", "Tue" …
  private async chartWeek(get: StripeGetter): Promise<ChartPoint[]> {
    const now = new Date()
    const day = now.getUTCDay()
    const daysSinceMonday = day === 0 ? 6 : day - 1
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - daysSinceMonday)
    monday.setUTCHours(0, 0, 0, 0)
    const mondayUnix = Math.floor(monday.getTime() / 1000)

    const charges = await this.fetchChargesSince(get, mondayUnix)

    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    // Build one bucket per day from Monday to today (0..daysSinceMonday)
    const numDays = daysSinceMonday + 1
    const buckets: number[] = new Array(numDays).fill(0)

    for (const c of charges) {
      if (c.status !== 'succeeded') continue
      const chargeDate = new Date(c.created * 1000)
      const dayIndex = Math.floor((chargeDate.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24))
      if (dayIndex >= 0 && dayIndex < numDays) buckets[dayIndex] += c.amount
    }

    return buckets.map((value, i) => {
      const d = new Date(monday)
      d.setUTCDate(monday.getUTCDate() + i)
      return { label: DAY_LABELS[d.getUTCDay()], value }
    })
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async upsertValue(connectionId: string, viewType: string, value: string): Promise<void> {
    const client = this.supabaseService.getClient()
    const today = new Date().toISOString().split('T')[0]

    const { data: view } = await client
      .from('views')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('type', viewType)
      .maybeSingle()

    if (!view) {
      this.logger.warn(`  ⚠ No view found for connectionId=${connectionId} type=${viewType}`)
      return
    }

    const viewId = view.id as string
    const { data: existing } = await client
      .from('views_values')
      .select('id')
      .eq('view_id', viewId)
      .eq('created_at', today)
      .maybeSingle()

    if (existing) {
      await client
        .from('views_values')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await client.from('views_values').insert({ view_id: viewId, value, created_at: today })
    }
  }
}
