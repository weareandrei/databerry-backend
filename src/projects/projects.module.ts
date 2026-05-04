import { Module } from '@nestjs/common'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { ViewsModule } from '../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  // Exported so other modules (e.g. ChatModule's tool layer) can
  // call `getProjects(userId)` directly instead of round-tripping
  // through the HTTP controller.
  exports: [ProjectsService],
})
export class ProjectsModule {}
