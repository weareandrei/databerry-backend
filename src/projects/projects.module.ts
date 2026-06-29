import { Module } from '@nestjs/common'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'
import { ProjectsRepository } from './projects.repository'
import { ViewsModule } from '../views/views.module'
import { ConnectionsModule } from '../connections/connections.module'

@Module({
  imports: [ViewsModule, ConnectionsModule],
  controllers: [ProjectsController],
  providers: [ProjectsRepository, ProjectsService],
  exports: [ProjectsService, ProjectsRepository],
})
export class ProjectsModule {}
