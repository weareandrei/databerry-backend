import { Module } from '@nestjs/common'
import { VercelConnectionController } from './connection.controller'
import { SupabaseModule } from '../../supabase/supabase.module'

@Module({
  imports: [SupabaseModule],
  controllers: [VercelConnectionController],
})
export class VercelConnectionModule {}
