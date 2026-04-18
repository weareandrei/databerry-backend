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

  async fetchLiveValue(connectionId: string, viewType: string, userId: string): Promise<string> {
    this.logger.log(`\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}`)
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    let value: string

    if (viewType === 'ga_active_users') {
      value = await fetchRealtimeActiveUsers(token, propertyId)
    } else {
      const metricName = metricForViewType(viewType)
      value = await fetchTodayMetric(token, propertyId, metricName)
    }

    await this.viewsService.upsertValue(connectionId, viewType, value)
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return value
  }
}
