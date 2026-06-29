import { Module } from '@nestjs/common'
import { ViewsController } from './views.controller'
import { ViewsService } from './views.service'
import { ViewsRepository } from './views.repository'
import { ConnectionsModule } from '../connections/connections.module'
import { PosthogModule } from '../posthog/posthog.module'

@Module({
  imports: [ConnectionsModule, PosthogModule],
  controllers: [ViewsController],
  providers: [ViewsRepository, ViewsService],
  exports: [ViewsService, ViewsRepository],
})
export class ViewsModule {}
