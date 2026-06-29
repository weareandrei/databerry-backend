import { Module } from '@nestjs/common'
import { UserSettingsController } from './user-settings.controller'
import { UserSettingsService } from './user-settings.service'
import { UserSettingsRepository } from './user-settings.repository'

@Module({
  controllers: [UserSettingsController],
  providers: [UserSettingsRepository, UserSettingsService],
  exports: [UserSettingsService],
})
export class UserSettingsModule {}
