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

  async fetchLiveValue(connectionId: string, viewType: string, userId: string, date?: string): Promise<string> {
    const targetDate = date ?? new Date().toISOString().split('T')[0]
    const isToday = targetDate === new Date().toISOString().split('T')[0]
    this.logger.log(`\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  date=${targetDate}`)
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    let value: string

    if (viewType === 'ga_active_users') {
      if (!isToday) {
        // Realtime API only works for the current moment — can't query past dates
        this.logger.log(`  → ga_active_users requested for past date (${targetDate}) — returning 0`)
        value = '0'
      } else {
        value = await fetchRealtimeActiveUsers(token, propertyId)
      }
    } else {
      const metricName = metricForViewType(viewType)
      value = await fetchTodayMetric(token, propertyId, metricName, targetDate)
    }

    await this.viewsService.upsertValue(connectionId, viewType, value, targetDate)
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return value
  }
}
