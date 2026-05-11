import { Module } from '@nestjs/common'
import { SentryConnectionModule } from './connection/connection.module'
import { SentryViewsModule } from './views/views.module'

@Module({
  imports: [SentryConnectionModule, SentryViewsModule],
})
export class SentryModule {}
