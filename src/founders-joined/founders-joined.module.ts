import { Module } from '@nestjs/common'
import { FoundersJoinedController } from './founders-joined.controller'
import { FoundersJoinedService } from './founders-joined.service'

/**
 * Public landing-page social-proof counter. SupabaseModule is global,
 * so we only wire controller + service here.
 */
@Module({
  controllers: [FoundersJoinedController],
  providers: [FoundersJoinedService],
})
export class FoundersJoinedModule {}
