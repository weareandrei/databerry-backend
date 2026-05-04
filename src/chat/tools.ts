/**
 * Tool registry for the Ask-AI chat (backend-side).
 *
 * Each tool is a (definition, handler) pair. Handlers call other
 * NestJS services *directly* — no HTTP round-trip — and receive
 * `userId` for per-user scoping. The service methods themselves
 * (e.g. `StripeViewsService.fetchLiveValue`) already do the
 * connection-ownership checks, so the chat layer doesn't need to
 * re-verify.
 *
 * Two of the tools (`list_projects`, `list_connections`) also get
 * pre-loaded into the system prompt at chat-start so Claude knows
 * the user's inventory without spending a turn discovering it.
 *
 * Adding a new tool = appending one entry to `buildTools()`. Keep
 * handlers thin: call a service, narrow the result, return JSON-
 * shaped data the model can reason about. Don't pre-format prose —
 * that's the model's job.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { ProjectsService } from '../projects/projects.service'
import type { ConnectionsService } from '../connections/connections.service'
import type { StripeViewsService } from '../stripe/views/views.service'
import type { CalendlyViewsService } from '../calendly/views/views.service'

export interface ToolCtx {
  userId: string
}

export interface ChatTool {
  definition: Anthropic.Tool
  handler: (input: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>
}

export interface ToolDeps {
  projects: ProjectsService
  connections: ConnectionsService
  stripeViews: StripeViewsService
  calendlyViews: CalendlyViewsService
}

// ── Stripe metric enums ────────────────────────────────────────────────────
//
// Two distinct sets — `fetchLiveValue` and `fetchChartData` accept
// different `viewType` values. Keep them separate or the model will
// occasionally send a chart-only enum to the live-value tool and
// the backend will 404.
const STRIPE_LIVE_METRICS = [
  'stripe_revenue_today',
  'stripe_gross_today',
  'stripe_gross',
  'stripe_mrr',
  'stripe_active_subs',
  'stripe_churn_rate',
] as const

const STRIPE_CHART_METRICS = [
  'stripe_gross_today',
  'stripe_gross_week',
  'stripe_gross',
] as const

export function buildTools(deps: ToolDeps): Record<string, ChatTool> {
  const listProjects: ChatTool = {
    definition: {
      name: 'list_projects',
      description:
        "List all of the user's projects. Each project has an `id` and `name`. Useful when the user refers to a project by name and you need its id for other tools.",
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_input, { userId }) => {
      const rows = await deps.projects.getProjects(userId)
      return rows.map(p => ({ id: p.id, name: p.name }))
    },
  }

  const listConnections: ChatTool = {
    definition: {
      name: 'list_connections',
      description:
        "List all of the user's data connections (Stripe, Calendly, etc.) with their type, project assignment, and id. Use this to find the right `connectionId` for a metric tool.",
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_input, { userId }) => {
      const rows = await deps.connections.getConnections(userId)
      return rows.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        projectId: c.projectId ?? null,
      }))
    },
  }

  const getStripeMetric: ChatTool = {
    definition: {
      name: 'get_stripe_metric',
      description:
        'Fetch a single Stripe metric value (live, point-in-time). Returns the metric in cents for currency metrics, or as a count/rate for others. Cite the metric name and the connection in your reply.',
      input_schema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Stripe connection id from `list_connections`.' },
          metric: {
            type: 'string',
            enum: [...STRIPE_LIVE_METRICS],
            description: 'Which metric to compute.',
          },
          dateFrom: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Defaults to today.' },
          dateTo: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Defaults to today.' },
          tz: { type: 'string', description: "IANA timezone (e.g. 'America/New_York')." },
        },
        required: ['connectionId', 'metric'],
      },
    },
    handler: async (input, { userId }) => {
      const data = await deps.stripeViews.fetchLiveValue(
        String(input.connectionId),
        String(input.metric),
        userId,
        input.dateFrom ? String(input.dateFrom) : undefined,
        input.dateTo ? String(input.dateTo) : undefined,
        input.tz ? String(input.tz) : undefined,
      )
      return {
        metric: input.metric,
        value: data.value,
        unavailable: data.unavailable ?? false,
        // Note: currency metrics are returned as cents. The model
        // should divide by 100 before formatting as USD.
        hint: 'currency metrics (revenue/gross/mrr) are in cents',
      }
    },
  }

  const getStripeChart: ChatTool = {
    definition: {
      name: 'get_stripe_chart',
      description:
        'Fetch a time-series for a Stripe metric (one point per day/week/month). Use this for "show me the trend" questions or to compute averages over a range.',
      input_schema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string' },
          metric: {
            type: 'string',
            enum: [...STRIPE_CHART_METRICS],
            description: 'Which metric to chart.',
          },
          mode: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Bucket size for the chart.',
          },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          tz: { type: 'string' },
        },
        required: ['connectionId', 'metric', 'mode'],
      },
    },
    handler: async (input, { userId }) => {
      const points = await deps.stripeViews.fetchChartData(
        String(input.connectionId),
        String(input.metric),
        userId,
        input.dateFrom ? String(input.dateFrom) : undefined,
        input.dateTo ? String(input.dateTo) : undefined,
        input.mode as 'daily' | 'weekly' | 'monthly' | undefined,
        input.tz ? String(input.tz) : undefined,
      )
      return {
        metric: input.metric,
        mode: input.mode,
        points,
        hint: 'currency metric values are in cents',
      }
    },
  }

  const getStripeTopCustomers: ChatTool = {
    definition: {
      name: 'get_stripe_top_customers',
      description:
        "List the top customers by gross revenue for a Stripe connection in a date range. Returns up to 10 customers with name, total amount (cents), and number of charges.",
      input_schema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          tz: { type: 'string' },
        },
        required: ['connectionId'],
      },
    },
    handler: async (input, { userId }) => {
      const data = await deps.stripeViews.fetchTopCustomers(
        String(input.connectionId),
        userId,
        input.dateFrom ? String(input.dateFrom) : undefined,
        input.dateTo ? String(input.dateTo) : undefined,
        input.tz ? String(input.tz) : undefined,
      )
      return { ...data, hint: 'amounts are in cents' }
    },
  }

  const getCalendlyMeetings: ChatTool = {
    definition: {
      name: 'get_calendly_meetings',
      description:
        "Fetch the user's Calendly meetings in a date range. Returns id, title, attendees and start/end times.",
      input_schema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          tz: { type: 'string' },
        },
        required: ['connectionId'],
      },
    },
    handler: async (input, { userId }) => {
      const meetings = await deps.calendlyViews.fetchMeetingsList(
        String(input.connectionId),
        userId,
        input.dateFrom ? String(input.dateFrom) : undefined,
        input.dateTo ? String(input.dateTo) : undefined,
        input.tz ? String(input.tz) : undefined,
      )
      return { meetings, count: meetings.length }
    },
  }

  return {
    list_projects: listProjects,
    list_connections: listConnections,
    get_stripe_metric: getStripeMetric,
    get_stripe_chart: getStripeChart,
    get_stripe_top_customers: getStripeTopCustomers,
    get_calendly_meetings: getCalendlyMeetings,
  }
}
