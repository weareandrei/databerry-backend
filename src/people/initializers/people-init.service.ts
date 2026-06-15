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

  /**
   * Sync people for a WHOLE project — runs initialization across
   * every identity-bearing connection that serves the project
   * (project-scoped to it OR Common). This is what the "Sync people"
   * button calls: one click, populate the project's people index
   * from all its sources at once.
   *
   * Connection types that don't carry people identity (webhook,
   * sentry, vercel, calendly-not-yet, mcp, …) are skipped — only the
   * ones the dispatcher above knows how to handle.
   *
   * Per-connection failures are swallowed + logged so one broken
   * credential doesn't abort the others; the caller gets the total
   * processed plus a per-connection breakdown.
   */
  async syncProject(
    userId: string,
    projectId: string,
  ): Promise<{
    processed: number
    connections: {
      connectionId: string
      source: string
      processed: number
      error?: string
    }[]
  }> {
    const { data: conns, error } = await this.supabaseService
      .getClient()
      .from('connections')
      .select('id, type')
      .eq('user_id', userId)
      // Identity-bearing types only — extend as new initializers land.
      .in('type', IDENTITY_CONNECTION_TYPES)
      // Project-scoped to this project OR Common (project_id null,
      // which serves every project).
      .or(`project_id.eq.${projectId},project_id.is.null`)
    if (error) throw new Error(error.message)

    const results: {
      connectionId: string
      source: string
      processed: number
      error?: string
    }[] = []
    let total = 0

    for (const row of conns ?? []) {
      const c = row as { id: string; type: string }
      try {
        const { processed, source } = await this.initialize(
          c.id,
          userId,
          projectId,
        )
        total += processed
        results.push({ connectionId: c.id, source, processed })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.logger.warn(
          `syncProject: connection ${c.id} (${c.type}) failed — ${detail}`,
        )
        results.push({ connectionId: c.id, source: c.type, processed: 0, error: detail })
      }
    }

    this.logger.log(
      `syncProject done  project=${projectId} connections=${results.length} people=${total}`,
    )
    return { processed: total, connections: results }
  }
}

/**
 * Connection types that carry end-user identity and have an
 * initializer wired. Keep in sync with the `switch` in
 * `initialize` — add a type here AND a case there together.
 */
const IDENTITY_CONNECTION_TYPES = ['stripe', 'stripe_manual', 'posthog']
