import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { FoldersService } from './folders.service';
import type { CreateFolderDto, UpdateFolderDto } from './folders.service';

@Controller('folders')
@UseGuards(SupabaseAuthGuard)
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Get()
  getAll(@Req() req: any) {
    return this.foldersService.getFolders(req.authUser.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.foldersService.getFolderById(id, req.authUser.id);
  }

  @Post()
  create(@Body() dto: CreateFolderDto, @Req() req: any) {
    return this.foldersService.createFolder(dto, req.authUser.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @Req() req: any) {
    return this.foldersService.updateFolder(id, dto, req.authUser.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.foldersService.deleteFolder(id, req.authUser.id);
  }
}
