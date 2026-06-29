import { Module } from '@nestjs/common'
import { ViewsRepository } from '../../views/views.repository'
import { PosthogWebhookService } from './handler'

@Module({
  providers: [ViewsRepository, PosthogWebhookService],
  exports: [PosthogWebhookService],
})
export class PosthogWebhookModule {}
