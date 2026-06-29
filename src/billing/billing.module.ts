import { Module } from '@nestjs/common'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'
import { BillingRepository } from './billing.repository'

@Module({
  controllers: [BillingController],
  providers: [BillingRepository, BillingService],
  exports: [BillingRepository],
})
export class BillingModule {}
