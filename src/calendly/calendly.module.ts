import { Module } from '@nestjs/common'
import { CalendlyConnectionModule } from './connection/connection.module'
import { CalendlyViewsModule } from './views/views.module'

@Module({
  imports: [CalendlyConnectionModule, CalendlyViewsModule],
})
export class CalendlyModule {}
