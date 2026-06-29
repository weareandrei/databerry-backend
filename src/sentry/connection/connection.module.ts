import { Module } from '@nestjs/common'
import { SentryOAuthService } from './oauth'
import { SentryConnectionController } from './connection.controller'
import { SentryRepository } from './sentry.repository'
import { ConnectionsModule } from '../../connections/connections.module'

@Module({
  imports: [ConnectionsModule],
  providers: [SentryRepository, SentryOAuthService],
  controllers: [SentryConnectionController],
  exports: [SentryOAuthService],
})
export class SentryConnectionModule {}
