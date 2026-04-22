import { Module } from '@nestjs/common'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { ViewsModule } from '../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
