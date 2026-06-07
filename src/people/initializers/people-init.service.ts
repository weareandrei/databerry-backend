import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../../supabase/supabase.service'
import { StripePeopleInitializer } from './stripe-people.initializer'
import { PosthogPeopleInitializer } from './posthog-people.initializer'

/**
 * Dispatcher that routes a "initialize people for this connection"
 * request to the right per-platform initializer based on the
 * connection's `type`. The single entry point both the manual
 * trigger endpoint and (later) connection-create hooks / the
 * scheduler call into.
 *
 * Today only Stripe is wired; PostHog + GA initializers slot in
 * here as they're built — each new `case` is the only change.
 */
@Injectable()
export class PeopleInitializationService {
  private readonly logger = new Logger(PeopleInitializationService.name)

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly stripeInitializer: StripePeopleInitializer,
    private readonly posthogInitializer: PosthogPeopleInitializer,
  ) {}

  /**
   * Resolve the connection's type (verifying ownership) and run the
   * matching initializer. If `projectId` isn't given, fall back to
   * the connection's own `project_id` — fails loudly if the
   * connection is Common (project_id null) and no project was
   * passed, since people are project-scoped and we'd have nowhere
   * to put them.
   */
  async initialize(
    connectionId: string,
    userId: string,
    projectId?: string,
  ): Promise<{ processed: number; source: string }> {
    const { data: conn, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('type, project_id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!conn) throw new NotFoundException('Connection not found')

    const type = (conn as { type: string }).type
    const targetProjectId =
      projectId ?? (conn as { project_id: string | null }).project_id
    if (!targetProjectId) {
      throw new BadRequestException(
        'This is a Common connection — pass projectId to choose which project the people belong to.',
      )
    }

    switch (type) {
      case 'stripe':
      case 'stripe_manual': {
        const { processed } = await this.stripeInitializer.initialize(
          connectionId,
          targetProjectId,
          userId,
        )
        return { processed, source: 'stripe' }
      }
      case 'posthog': {
        const { processed } = await this.posthogInitializer.initialize(
          connectionId,
          targetProjectId,
          userId,
        )
        return { processed, source: 'posthog' }
      }
      default:
        throw new BadRequestException(
          `People initialization not yet supported for connection type '${type}'.`,
        )
    }
  }
}
