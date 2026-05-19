import { Module } from '@nestjs/common'
import { ChatController } from './chat.controller'
import { ChatService } from './chat.service'
import { ProjectsModule } from '../projects/projects.module'
import { ConnectionsModule } from '../connections/connections.module'
import { StripeViewsModule } from '../stripe/views/views.module'
import { CalendlyViewsModule } from '../calendly/views/views.module'
import { PosthogViewsModule } from '../posthog/views/views.module'

/**
 * Owns the Anthropic-backed chat endpoint (`POST /chat`).
 *
 * Imports the five "data source" modules whose services the chat
 * tools call: ProjectsModule, ConnectionsModule, StripeViewsModule,
 * CalendlyViewsModule, PosthogViewsModule. Each of those exports
 * its service so the tool handlers can run in-process (no HTTP
 * round-trip).
 */
@Module({
  imports: [
    ProjectsModule,
    ConnectionsModule,
    StripeViewsModule,
    CalendlyViewsModule,
    PosthogViewsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
