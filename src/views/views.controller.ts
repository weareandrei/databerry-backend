import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard'
import { ViewsService } from './views.service'
import type { CreateViewDto } from './views.service'

@Controller('views')
@UseGuards(SupabaseAuthGuard)
export class ViewsController {
  constructor(private readonly viewsService: ViewsService) {}

  @Get()
  getByFolder(
    @Query('folderId') folderId: string,
    @Query('date') date: string | undefined,
    @Req() req: any,
  ) {
    return this.viewsService.getViewsByFolder(folderId, req.authUser.id, date)
  }

  @Post()
  create(@Body() dto: CreateViewDto, @Req() req: any) {
    return this.viewsService.createView(dto, req.authUser.id)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.viewsService.deleteView(id, req.authUser.id)
  }
}
