import { Injectable, Logger } from '@nestjs/common'
import { CalendlyOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
import { buildViewFetchContext } from '../../common/view-fetch-context'
import { computeMeetingsRange } from './live/meetings-today'
import { computeMeetingsList } from './live/meetings-list'
import type { CalendlyMeeting } from './live/meetings-list'

@Injectable()
export class CalendlyViewsService {
  private readonly logger = new Logger(CalendlyViewsService.name)

  constructor(
    private readonly oauthService: CalendlyOAuthService,
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
    const { from, to, isSingleDay, tz: tzLit } = buildViewFetchContext(dateFrom, dateTo, tz)

    this.logger.log(
      `fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  ${from}→${to}  tz=${tzLit}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    const value = await computeMeetingsRange(token, connectionId, userUri, from, to, tzLit)

    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }
    this.logger.log(`fetchLiveValue → ${value}`)
    return { value }
  }

  async fetchMeetingsList(
    connectionId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
    tz: string = 'UTC',
  ): Promise<CalendlyMeeting[]> {
    this.logger.log(
      `fetchMeetingsList  connectionId=${connectionId}  dateFrom=${dateFrom}  dateTo=${dateTo}  tz=${tz}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    return computeMeetingsList(token, connectionId, userUri, this.logger, dateFrom, dateTo, tz)
  }
}
