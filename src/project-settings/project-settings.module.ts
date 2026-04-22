import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { ProjectSettingsController } from './project-settings.controller'
import { ProjectSettingsService } from './project-settings.service'

@Module({
  imports: [SupabaseModule],
  controllers: [ProjectSettingsController],
  providers: [ProjectSettingsService],
  exports: [ProjectSettingsService],
})
export class ProjectSettingsModule {}
