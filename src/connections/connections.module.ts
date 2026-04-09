import { Module } from '@nestjs/common'
import { ConnectionsController } from './connections.controller'
import { ConnectionsService } from './connections.service'
import { PosthogModule } from '../posthog/posthog.module'

@Module({
  imports: [PosthogModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
})
export class ConnectionsModule {}
