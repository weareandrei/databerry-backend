import { Injectable, Logger } from '@nestjs/common'
import { CalendlyOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
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
  ): Promise<{ value: string | null; unavailable?: boolean }> {
    const todayStr = new Date().toISOString().split('T')[0]
    const from = dateFrom ?? todayStr
    const to = dateTo ?? from
    const isSingleDay = from === to

    this.logger.log(
      `\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}  dateFrom=${from}  dateTo=${to}`,
    )
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    const value = await computeMeetingsRange(token, userUri, from, to)

    if (isSingleDay) {
      await this.viewsService.upsertValue(connectionId, viewType, value, from)
    }
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return { value }
  }

  async fetchMeetingsList(
    connectionId: string,
    userId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<CalendlyMeeting[]> {
    this.logger.log(`\n  ► fetchMeetingsList  connectionId=${connectionId}  dateFrom=${dateFrom}  dateTo=${dateTo}`)
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    return computeMeetingsList(token, userUri, this.logger, dateFrom, dateTo)
  }
}
