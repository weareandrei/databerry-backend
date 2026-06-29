import { Module } from '@nestjs/common'
import { FoldersController } from './folders.controller'
import { FoldersService } from './folders.service'
import { FoldersRepository } from './folders.repository'

@Module({
  controllers: [FoldersController],
  providers: [FoldersRepository, FoldersService],
})
export class FoldersModule {}
