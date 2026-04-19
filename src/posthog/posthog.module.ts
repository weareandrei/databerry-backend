import { Module } from '@nestjs/common'
import { PosthogConnectionModule } from './connection/connection.module'
import { PosthogLifecycleModule } from './lifecycle/lifecycle.module'
import { PosthogWebhookModule } from './webhook/webhook.module'
import { PosthogViewsModule } from './views/views.module'

@Module({
  imports: [PosthogConnectionModule, PosthogLifecycleModule, PosthogWebhookModule, PosthogViewsModule],
  exports: [PosthogConnectionModule, PosthogLifecycleModule, PosthogWebhookModule, PosthogViewsModule],
})
export class PosthogModule {}
