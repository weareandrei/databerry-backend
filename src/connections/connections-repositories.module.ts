import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { ConnectionsRepository } from './connections.repository'

@Module({
  imports: [SupabaseModule],
  providers: [ConnectionsRepository],
  exports: [ConnectionsRepository],
})
export class ConnectionsRepositoriesModule {}
