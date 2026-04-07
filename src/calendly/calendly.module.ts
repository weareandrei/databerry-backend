import { Module } from '@nestjs/common';
import { CalendlyService } from './calendly.service';
import { CalendlyController } from './calendly.controller';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [CalendlyService],
  controllers: [CalendlyController],
})
export class CalendlyModule {}
