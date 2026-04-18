import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { ViewsService } from '../../views/views.service'
import { getApiKey, makeStripeGetter } from './stripe-api.helpers'
import { computeRevenueToday } from './live/revenue-today'
import { computeGrossToday } from './live/gross-today'
import { computeGrossWeek } from './live/gross-week'
import type { ChartPoint } from './stripe-api.helpers'

@Injectable()
export class StripeViewsService {
  private readonly logger = new Logger(StripeViewsService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly viewsService: ViewsService,
  ) {}

  async fetchLiveValue(connectionId: string, viewType: string, userId: string): Promise<string> {
    this.logger.log(`\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}`)
    const apiKey = await getApiKey(connectionId, userId, this.supabaseService)
    const get = makeStripeGetter(apiKey)

    let value: string
    switch (viewType) {
      case 'stripe_revenue_today':
      case 'stripe_gross_today':
        value = await computeRevenueToday(get)
        break
      default:
        throw new NotFoundException(`Unknown live view type: ${viewType}`)
    }

    await this.viewsService.upsertValue(connectionId, viewType, value)
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return value
  }

  async fetchChartData(
    connectionId: string,
    viewType: string,
    userId: string,
  ): Promise<ChartPoint[]> {
    this.logger.log(`\n  ► fetchChartData  connectionId=${connectionId}  viewType=${viewType}`)
    const apiKey = await getApiKey(connectionId, userId, this.supabaseService)
    const get = makeStripeGetter(apiKey)

    switch (viewType) {
      case 'stripe_gross_today':
        return computeGrossToday(get)
      case 'stripe_gross_week':
        return computeGrossWeek(get)
      default:
        throw new NotFoundException(`No chart data for view type: ${viewType}`)
    }
  }
}
