import { Module } from '@nestjs/common'
import { SupabaseModule } from '../supabase/supabase.module'
import { PeopleController } from './people.controller'
import { PeopleService } from './people.service'
import { PeopleMatchingService } from './people-matching.service'
import { PeopleEventsService } from './people-events.service'
import { StripePeopleInitializer } from './initializers/stripe-people.initializer'
import { PosthogPeopleInitializer } from './initializers/posthog-people.initializer'
import { PeopleInitializationService } from './initializers/people-init.service'

/**
 * Cross-platform people graph.
 *   - Phase 1: read surface (`PeopleService` + controller).
 *   - Phase 2: matching / bridging engine (`PeopleMatchingService`)
 *     + per-platform initializers (`StripePeopleInitializer`,
 *     `PosthogPeopleInitializer`, with GA to follow).
 *
 * Services are exported so connection-create hooks, the scheduler,
 * and the later event-ingestion phase can drive initialization
 * without going back through HTTP.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [PeopleController],
  providers: [
    PeopleService,
    PeopleMatchingService,
    PeopleEventsService,
    StripePeopleInitializer,
    PosthogPeopleInitializer,
    PeopleInitializationService,
  ],
  exports: [
    PeopleService,
    PeopleMatchingService,
    PeopleEventsService,
    StripePeopleInitializer,
    PosthogPeopleInitializer,
    PeopleInitializationService,
  ],
})
export class PeopleModule {}
