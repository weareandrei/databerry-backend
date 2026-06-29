import { Module } from '@nestjs/common'
import { ConnectionsModule } from '../connections/connections.module'
import { PosthogConnectionModule } from '../posthog/connection/connection.module'
import { PeopleController } from './people.controller'
import { PeopleService } from './people.service'
import { PeopleMatchingService } from './people-matching.service'
import { PeopleEventsService } from './people-events.service'
import { StripeSync } from './sync-connectors/stripe.sync'
import { PosthogSync } from './sync-connectors/posthog.sync'
import { PeopleSyncService } from './people-sync.service'
import { PeopleRepository } from './people.repository'

/**
 * Cross-platform people graph.
 *   - Phase 1: read surface (`PeopleService` + controller).
 *   - Phase 2: matching / bridging engine (`PeopleMatchingService`)
 *     + per-platform sync (`StripeSync`, `PosthogSync`), orchestrated
 *     by `PeopleSyncService`.
 */
@Module({
  imports: [ConnectionsModule, PosthogConnectionModule],
  controllers: [PeopleController],
  providers: [
    PeopleRepository,
    PeopleService,
    PeopleMatchingService,
    PeopleEventsService,
    StripeSync,
    PosthogSync,
    PeopleSyncService,
  ],
  exports: [
    PeopleService,
    PeopleMatchingService,
    PeopleEventsService,
    StripeSync,
    PosthogSync,
    PeopleSyncService,
  ],
})
export class PeopleModule {}
