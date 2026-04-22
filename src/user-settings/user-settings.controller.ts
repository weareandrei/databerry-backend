import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { UserSettingsService } from './user-settings.service'
import type { UpdateUserSettingsDto } from './user-settings.service'
import type { AuthenticatedRequest } from '../common/types'

@UseGuards(SupabaseAuthGuard)
@Controller('user-settings')
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Get()
  async get(@Req() req: AuthenticatedRequest) {
    return this.userSettingsService.get(req.authUser.id)
  }

  @Put()
  async update(@Body() dto: UpdateUserSettingsDto, @Req() req: AuthenticatedRequest) {
    return this.userSettingsService.update(req.authUser.id, dto)
  }
}
