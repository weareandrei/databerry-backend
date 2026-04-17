import { Module } from '@nestjs/common'
import { CalendlyService } from './calendly.service'
import { CalendlyController } from './calendly.controller'
import { SupabaseModule } from '../supabase/supabase.module'
import { ViewsModule } from '../views/views.module'

@Module({
  imports: [SupabaseModule, ViewsModule],
  providers: [CalendlyService],
  controllers: [CalendlyController],
})
export class CalendlyModule {}
