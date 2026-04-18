import { Module } from '@nestjs/common'
import { CalendlyViewsController } from './views.controller'
import { CalendlyViewsService } from './views.service'
import { CalendlyConnectionModule } from '../connection/connection.module'
import { ViewsModule } from '../../views/views.module'

@Module({
  imports: [CalendlyConnectionModule, ViewsModule],
  controllers: [CalendlyViewsController],
  providers: [CalendlyViewsService],
})
export class CalendlyViewsModule {}
