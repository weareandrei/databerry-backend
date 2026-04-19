import { Module } from '@nestjs/common'
import { VercelConnectionModule } from './connection/connection.module'

@Module({
  imports: [VercelConnectionModule],
})
export class VercelModule {}
