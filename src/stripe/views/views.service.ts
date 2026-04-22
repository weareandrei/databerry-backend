import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ViewsService } from '../../views/views.service'
import { getApiKey, makeStripeGetter } from './stripe-api.helpers'
import { computeRevenueRange } from './live/revenue-today'
import { computeGrossToday, computeHourlyGross } from './live/gross-today'
import { computeGrossWeek, computeDailyGross } from './live/gross-week'
import type { ChartPoint } from './stripe-api.helpers'

type ChartMode = 'daily' | 'weekly' | 'monthly'

@Injectable()
export class StripeViewsService {
  private readonly logger = new Logger(StripeViewsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly viewsService: ViewsService,
  ) {}

  async fetchLiveValue(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from
    const isSingleDay = from === to

    this.logger.log(
      `\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  dateFrom=${from}  dateTo=${to}`,
    )
    const apiKey = await getApiKey(connectionId, userId, this.supabaseService)
    const get = makeStripeGetter(apiKey)

    let value: string
    switch (viewType) {
      case 'stripe_revenue_today':
      case 'stripe_gross_today':
      case 'stripe_gross':
        value = await computeRevenueRange(get, from, to)
        break
      default:
        throw new NotFoundException(`Unknown live view type: ${viewType}`)
    }

    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return { value }
  }

  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    mode?: ChartMode,
  ): Promise<ChartPoint[]> {
    this.logger.log(
      `\n  ► fetchChartData  connectionId=${connectionId}  viewType=${viewType}  dateFrom=${dateFrom}  dateTo=${dateTo}  mode=${mode}`,
    )
    const apiKey = await getApiKey(connectionId, userId, this.supabaseService)
    const get = makeStripeGetter(apiKey)

    switch (viewType) {
      case 'stripe_gross_today':
        // Legacy behaviour: ignore incoming dates, always return today's hourly chart.
        return computeGrossToday(get)
      case 'stripe_gross_week':
        // Legacy behaviour: ignore incoming dates, always return this week's daily chart.
        return computeGrossWeek(get)
      case 'stripe_gross': {
        // New unified chart — shape depends on the current mode.
        const todayStr = new Date().toISOString().split('T')[0]
        const from = dateFrom ?? todayStr
        const to = dateTo ?? from
        if (mode === 'daily' || (!mode && from === to)) {
          return computeHourlyGross(get, from)
        }
        return computeDailyGross(get, from, to)
      }
      default:
        throw new NotFoundException(`No chart data for view type: ${viewType}`)
    }
  }
}
