import { Module } from '@nestjs/common'
import { PosthogLifecycleService } from './hog-function'
import { PosthogConnectionModule } from '../connection/connection.module'

@Module({
  imports: [PosthogConnectionModule],
  providers: [PosthogLifecycleService],
  exports: [PosthogLifecycleService],
})
export class PosthogLifecycleModule {}
