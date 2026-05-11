import { Module } from '@nestjs/common'
import { SentryViewsController } from './views.controller'
import { SentryViewsService } from './views.service'
import { SentryConnectionModule } from '../connection/connection.module'

@Module({
  imports: [SentryConnectionModule],
  controllers: [SentryViewsController],
  providers: [SentryViewsService],
  exports: [SentryViewsService],
})
export class SentryViewsModule {}
