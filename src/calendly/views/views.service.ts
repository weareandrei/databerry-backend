import { Injectable, Logger } from '@nestjs/common'
import { CalendlyOAuthService } from '../connection/oauth'
import { ViewsService } from '../../views/views.service'
import { computeMeetingsToday } from './live/meetings-today'
import { computeMeetingsList } from './live/meetings-list'
import type { CalendlyMeeting } from './live/meetings-list'

@Injectable()
export class CalendlyViewsService {
  private readonly logger = new Logger(CalendlyViewsService.name)

  constructor(
    private readonly oauthService: CalendlyOAuthService,
    private readonly viewsService: ViewsService,
  ) {}

  async fetchLiveValue(connectionId: string, viewType: string, userId: string): Promise<string> {
    this.logger.log(`\n  ► fetchLiveValue  connectionId=${connectionId}  viewType=${viewType}`)
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    const value = await computeMeetingsToday(token, userUri)
    await this.viewsService.upsertValue(connectionId, viewType, value)
    this.logger.log(`  ✓ fetchLiveValue → ${value}`)
    return value
  }

  async fetchMeetingsList(connectionId: string, userId: string): Promise<CalendlyMeeting[]> {
    this.logger.log(`\n  ► fetchMeetingsList  connectionId=${connectionId}`)
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    const userUri = await this.oauthService.getUserUri(connectionId)

    return computeMeetingsList(token, userUri, this.logger)
  }
}
