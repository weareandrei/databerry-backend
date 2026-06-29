import { Module } from '@nestjs/common'
import { ConnectionsRepositoriesModule } from '../../connections/connections-repositories.module'
import { ViewsRepository } from '../../views/views.repository'
import { PosthogConnectionModule } from '../connection/connection.module'
import { PosthogViewsController } from './views.controller'
import { PosthogViewsService } from './views.service'

// `ConnectionsRepositoriesModule` (not full `ConnectionsModule`) avoids the
// `ConnectionsModule` → `PosthogModule` → `PosthogViewsModule` cycle;
// `PosthogViewsService` only needs `ConnectionsRepository`.
@Module({
  imports: [ConnectionsRepositoriesModule, PosthogConnectionModule],
  controllers: [PosthogViewsController],
  providers: [ViewsRepository, PosthogViewsService],
  exports: [PosthogViewsService],
})
export class PosthogViewsModule {}
