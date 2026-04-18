import { Module } from '@nestjs/common'
import { CalendlyOAuthService } from './oauth'
import { CalendlyConnectionController } from './connection.controller'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  providers: [CalendlyOAuthService],
  controllers: [CalendlyConnectionController],
  exports: [CalendlyOAuthService],
})
export class CalendlyConnectionModule {}
