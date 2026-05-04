import { Module } from '@nestjs/common'
import { ConnectionsController } from './connections.controller'
import { ConnectionsService } from './connections.service'
import { PosthogModule } from '../posthog/posthog.module'
import { StripeSyncModule } from '../stripe/sync/sync.module'

@Module({
  imports: [PosthogModule, StripeSyncModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  // Exported so ChatModule's tool layer can list a user's
  // connections in-process. Same per-user scoping as the controller
  // — `getConnections(userId)` filters by user.
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
