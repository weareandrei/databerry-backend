import { Module } from '@nestjs/common'
import { ConnectionsController } from './connections.controller'
import { ConnectionsService } from './connections.service'
import { PosthogModule } from '../posthog/posthog.module'
import { StripeSyncModule } from '../stripe/sync/sync.module'

@Module({
  imports: [PosthogModule, StripeSyncModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
})
export class ConnectionsModule {}
