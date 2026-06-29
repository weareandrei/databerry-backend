import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { StripeConnectionController } from './connection.controller'
import { StripeOAuthService } from './oauth'
import { StripeSyncModule } from '../sync/sync.module'

@Module({
  imports: [ConnectionsRepositoriesModule, StripeSyncModule],
  controllers: [StripeConnectionController],
  providers: [StripeOAuthService],
})
export class StripeConnectionModule {}
