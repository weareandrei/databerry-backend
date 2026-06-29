import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { PosthogCredentialsService } from './credentials'
import { PosthogConnectionController } from './connection.controller'
import { PosthogRepository } from './posthog.repository'

// Import the lightweight repositories module (not the full `ConnectionsModule`)
// to break the cycle: `ConnectionsModule` → `PosthogModule` →
// `PosthogConnectionModule`. We only need `ConnectionsRepository` here.
@Module({
  imports: [ConnectionsRepositoriesModule],
  controllers: [PosthogConnectionController],
  providers: [PosthogRepository, PosthogCredentialsService],
  exports: [PosthogRepository, PosthogCredentialsService],
})
export class PosthogConnectionModule {}
