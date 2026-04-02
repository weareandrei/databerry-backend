import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AccountsService } from './accounts.service';

@Controller('accounts')
@UseGuards(SupabaseAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get('me')
  getMe(@Req() req: any) {
    return this.accountsService.getOrCreateAccount(req.authUser.id);
  }
}
