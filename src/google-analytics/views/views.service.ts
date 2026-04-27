import { Injectable, Logger } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
import { metricForViewType, fetchRealtimeActiveUsers, fetchTodayMetric } from './live/metrics'

@Injectable()
export class GoogleAnalyticsViewsService {
  private readonly logger = new Logger(GoogleAnalyticsViewsService.name)

  constructor(
    private readonly oauthService: GoogleAnalyticsOAuthService,
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
    const isToday = from === todayStr && to === todayStr
    const isSingleDay = from === to

    this.logger.log(
      `\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  dateFrom=${from}  dateTo=${to}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    let value: string

    if (viewType === 'ga_active_users') {
      if (!isToday) {
        // Realtime API only produces a current snapshot — no past-range equivalent.
        this.logger.log(`  → ga_active_users requested for non-today range — unavailable`)
        return { value: null, unavailable: true }
      }
      value = await fetchRealtimeActiveUsers(token, connectionId, propertyId)
    } else {
      const metricName = metricForViewType(viewType)
      value = await fetchTodayMetric(token, connectionId, propertyId, metricName, from, to)
    }

    // Only persist stored daily values for single-day queries.
    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return { value }
  }
}
