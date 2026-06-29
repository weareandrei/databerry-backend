import { Module } from '@nestjs/common'
import { CalendlyOAuthService } from './oauth'
import { CalendlyConnectionController } from './connection.controller'
import { CalendlyRepository } from './calendly.repository'
import { ConnectionsModule } from '../../connections/connections.module'

@Module({
  imports: [ConnectionsModule],
  providers: [CalendlyRepository, CalendlyOAuthService],
  controllers: [CalendlyConnectionController],
  exports: [CalendlyOAuthService],
})
export class CalendlyConnectionModule {}
