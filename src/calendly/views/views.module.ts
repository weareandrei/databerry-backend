import { Module } from '@nestjs/common'
import { CalendlyViewsController } from './views.controller'
import { CalendlyViewsService } from './views.service'
import { CalendlyConnectionModule } from '../connection/connection.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [CalendlyConnectionModule, ViewsModule],
  controllers: [CalendlyViewsController],
  providers: [CalendlyViewsService],
  // Exported so ChatModule's tool handlers can fetch the meetings
  // list in-process.
  exports: [CalendlyViewsService],
})
export class CalendlyViewsModule {}
