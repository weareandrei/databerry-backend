import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { GoogleAnalyticsOAuthService } from './oauth'
import type { GAProperty } from '../google-analytics-admin.client'
import { GoogleAnalyticsRepository } from './google-analytics.repository'

@Injectable()
export class GoogleAnalyticsPropertiesService {
  private readonly logger = new Logger(GoogleAnalyticsPropertiesService.name)

  constructor(
    private readonly gaRepository: GoogleAnalyticsRepository,
    private readonly oauthService: GoogleAnalyticsOAuthService,
  ) {}

  async getProperties(connectionId: string, userId: string): Promise<GAProperty[]> {
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    return this.oauthService.listPropertiesWithToken(token, { userId, connectionId })
  }

  async saveProperty(connectionId: string, propertyId: string, userId: string): Promise<void> {
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)

    const properties = await this.oauthService.listPropertiesWithToken(token, {
      userId,
      connectionId,
    })
    const prop = properties.find(p => p.id === propertyId)
    if (!prop) throw new NotFoundException(`Property ${propertyId} not found or not accessible`)

    const { error } = await this.gaRepository.updateProperty(
      connectionId,
      propertyId,
      prop.displayName,
    )
    if (error) throw new Error(`Failed to save GA property: ${error.message}`)

    this.logger.log(`Saved GA property ${propertyId} (${prop.displayName}) for connection ${connectionId}`)
  }
}
