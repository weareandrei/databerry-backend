import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ConnectionsService } from './connections.service';
import type { CreateConnectionDto, UpdateConnectionDto } from './connections.service';

@Controller('connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Get()
  getAll(@Req() req: any) {
    return this.connectionsService.getConnections(req.authUser.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.connectionsService.getConnectionById(id, req.authUser.id);
  }

  @Post()
  create(@Body() dto: CreateConnectionDto, @Req() req: any) {
    return this.connectionsService.createConnection(dto, req.authUser.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateConnectionDto,
    @Req() req: any,
  ) {
    return this.connectionsService.updateConnection(id, dto, req.authUser.id);
  }

  @Get(':id/posthog/event-definitions')
  getPosthogEventDefinitions(@Param('id') id: string, @Req() req: any) {
    return this.connectionsService.getPosthogEventDefinitions(id, req.authUser.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.connectionsService.deleteConnection(id, req.authUser.id);
  }
}
