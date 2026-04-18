import { Module } from '@nestjs/common'
import { PosthogConnectionModule } from './connection/connection.module'
import { PosthogLifecycleModule } from './lifecycle/lifecycle.module'
import { PosthogWebhookModule } from './webhook/webhook.module'

@Module({
  imports: [PosthogConnectionModule, PosthogLifecycleModule, PosthogWebhookModule],
  exports: [PosthogConnectionModule, PosthogLifecycleModule, PosthogWebhookModule],
})
export class PosthogModule {}
