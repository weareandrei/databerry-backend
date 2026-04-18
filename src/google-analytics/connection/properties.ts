import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { GoogleAnalyticsOAuthService } from './oauth'
import type { GAProperty } from './oauth'

@Injectable()
export class GoogleAnalyticsPropertiesService {
  private readonly logger = new Logger(GoogleAnalyticsPropertiesService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly oauthService: GoogleAnalyticsOAuthService,
  ) {}

  async getProperties(connectionId: string, userId: string): Promise<GAProperty[]> {
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)
    return this.oauthService.listPropertiesWithToken(token)
  }

  async saveProperty(connectionId: string, propertyId: string, userId: string): Promise<void> {
    await this.oauthService.verifyOwnership(connectionId, userId)
    const token = await this.oauthService.ensureFreshToken(connectionId)

    const properties = await this.oauthService.listPropertiesWithToken(token)
    const prop = properties.find(p => p.id === propertyId)
    if (!prop) throw new NotFoundException(`Property ${propertyId} not found or not accessible`)

    await this.supabaseService
      .getClient()
      .from('connections_google_analytics')
      .update({ property_id: propertyId, property_name: prop.displayName })
      .eq('connection_id', connectionId)

    this.logger.log(`Saved GA property ${propertyId} for connection ${connectionId}`)
  }
}
