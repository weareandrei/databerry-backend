import { Module } from '@nestjs/common'
import { ConnectionsController } from './connections.controller'
import { ConnectionsService } from './connections.service'
import { ConnectionsRepositoriesModule } from './connections-repositories.module'
import { PosthogModule } from '../posthog/posthog.module'
import { StripeSyncModule } from '../stripe/sync/sync.module'

@Module({
  imports: [PosthogModule, StripeSyncModule, ConnectionsRepositoriesModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService, ConnectionsRepositoriesModule],
})
export class ConnectionsModule {}
