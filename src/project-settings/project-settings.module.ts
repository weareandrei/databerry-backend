import { Module } from '@nestjs/common'
import { ProjectSettingsController } from './project-settings.controller'
import { ProjectSettingsService } from './project-settings.service'
import { ProjectSettingsRepository } from './project-settings.repository'
import { ProjectsModule } from '../projects/projects.module'

@Module({
  imports: [ProjectsModule],
  controllers: [ProjectSettingsController],
  providers: [ProjectSettingsRepository, ProjectSettingsService],
  exports: [ProjectSettingsService],
})
export class ProjectSettingsModule {}
