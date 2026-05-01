import { Injectable, Logger } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
import { buildViewFetchContext } from '../../common/view-fetch-context'
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
    tz: string = 'UTC',
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const { from, to, isSingleDay, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)
    // GA's realtime endpoint is the only one without a historical mode —
    // we keep `isToday` as a separate flag from the generic
    // `isSingleDay` because they aren't the same idea (a single-day
    // query for *yesterday* is single-day but not today).
    const isToday = from === todayStr && to === todayStr

    this.logger.log(
      `fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}  tz=${tzLit}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const propertyId = await this.oauthService.getPropertyId(connectionId)

    let value: string

    if (viewType === 'ga_active_users') {
      if (!isToday) {
        // Realtime API only produces a current snapshot — no past-range equivalent.
        this.logger.log('ga_active_users requested for non-today range — unavailable')
        return { value: null, unavailable: true }
      }
      // Realtime is "right now" — no date range to align, no tz to thread.
      value = await fetchRealtimeActiveUsers(token, connectionId, propertyId)
    } else {
      // GA's runReport doesn't support a per-request `timeZone` — it
      // always evaluates `dateRanges` in the property's configured zone.
      // We accept `tz` for parity with the other integrations but drop
      // it on the floor here (project-overview's chart logs a warning
      // when GA's property tz disagrees with the user's tz).
      const metricName = metricForViewType(viewType)
      value = await fetchTodayMetric(token, connectionId, propertyId, metricName, from, to)
    }

    // Only persist stored daily values for single-day queries.
    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }

    this.logger.log(`fetchLiveValue → ${value}`)
    return { value }
  }
}
