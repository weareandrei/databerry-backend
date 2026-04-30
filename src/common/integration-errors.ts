import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * The set of integrations that can produce auth/upstream errors with a
 * structured payload. Stripe and PostHog don't appear here — Stripe live
 * data comes from our own Supabase cache (no live OAuth call), and PostHog
 * uses a permanent personal API key that doesn't go through OAuth refresh.
 */
export type IntegrationKey = 'google_analytics' | 'calendly'

/**
 * Stable error codes returned in the `error` field of the response body.
 * The frontend branches on these; do not rename casually.
 *
 *   INTEGRATION_NEEDS_REAUTH   — refresh token is dead / scope was revoked.
 *                                 The user must reconnect the integration.
 *   INTEGRATION_UPSTREAM_ERROR — provider returned a non-auth failure
 *                                 (404, 429, 5xx, network). Not the user's
 *                                 fault, not fixed by reconnecting.
 */
export type IntegrationErrorCode =
  | 'INTEGRATION_NEEDS_REAUTH'
  | 'INTEGRATION_UPSTREAM_ERROR'
  | 'CONNECTION_MISSING'

interface IntegrationErrorPayload {
  error: IntegrationErrorCode
  integration: IntegrationKey
  connectionId: string
  detail?: string
}

/**
 * Same shape as `IntegrationErrorPayload` but with a wider `integration`
 * field — `ConnectionMissingException` applies to every provider (including
 * stripe / stripe_manual / posthog), not just OAuth-refreshable ones, so
 * we can't reuse `IntegrationKey` here.
 */
interface ConnectionMissingPayload {
  error: 'CONNECTION_MISSING'
  integration: string
  connectionId: string
  detail?: string
}

/**
 * Thrown when the stored OAuth credential for an integration can no longer
 * mint a fresh access token (refresh token revoked / 7-day testing-mode
 * expiry / scope changed). Returns HTTP 401 with a structured body so the
 * frontend can render an inline "Reconnect <Integration>" prompt instead
 * of a generic error.
 *
 * No DB-side memoization: every subsequent request re-attempts the refresh
 * and 4xx's again. That's ~200ms + one Google/Calendly API call per
 * dashboard load on a broken connection — acceptable until/unless a single
 * stuck connection ever generates enough churn to matter.
 */
export class IntegrationReauthRequiredException extends HttpException {
  readonly integration: IntegrationKey
  readonly connectionId: string

  constructor(integration: IntegrationKey, connectionId: string, detail?: string) {
    const payload: IntegrationErrorPayload = {
      error: 'INTEGRATION_NEEDS_REAUTH',
      integration,
      connectionId,
      ...(detail ? { detail } : {}),
    }
    super(payload, HttpStatus.UNAUTHORIZED)
    this.integration = integration
    this.connectionId = connectionId
  }
}

/**
 * Thrown when the integration provider returned a non-auth failure while
 * we held a valid token (404 property-not-found, 429 quota-exceeded,
 * network error, 5xx). Distinct from the auth case so the frontend
 * doesn't show a misleading "reconnect" prompt for transient upstream
 * problems. Returns HTTP 502 — we successfully reached the upstream API,
 * but it gave us back something we can't use.
 */
export class IntegrationUpstreamException extends HttpException {
  readonly integration: IntegrationKey
  readonly connectionId: string

  constructor(integration: IntegrationKey, connectionId: string, detail?: string) {
    const payload: IntegrationErrorPayload = {
      error: 'INTEGRATION_UPSTREAM_ERROR',
      integration,
      connectionId,
      ...(detail ? { detail } : {}),
    }
    super(payload, HttpStatus.BAD_GATEWAY)
    this.integration = integration
    this.connectionId = connectionId
  }
}

/**
 * Thrown when a request references a `connectionId` that no longer exists
 * for the current user — typically because the user (or an admin) deleted
 * the connection while a view tile was still open. The view's
 * `connection_id` FK is now dangling.
 *
 * Returns HTTP 410 Gone so the frontend can branch on it cleanly:
 * `apiFetch` parses this into a `ConnectionMissingError`, and the view
 * tile then offers an inline "Reconnect" entry point that opens the
 * `ReassignConnectionDialog` (instead of the misleading generic
 * "Couldn't load value" badge).
 *
 * Distinct from `IntegrationReauthRequiredException` (401 — credential
 * expired but connection row still exists) and from a missing project /
 * folder etc. (still `NotFoundException` 404). Distinct from `IntegrationKey`
 * because this case can fire for stripe / stripe_manual / posthog too,
 * which never go through OAuth refresh.
 */
export class ConnectionMissingException extends HttpException {
  readonly integration: string
  readonly connectionId: string

  constructor(integration: string, connectionId: string, detail?: string) {
    const payload: ConnectionMissingPayload = {
      error: 'CONNECTION_MISSING',
      integration,
      connectionId,
      ...(detail ? { detail } : {}),
    }
    super(payload, HttpStatus.GONE)
    this.integration = integration
    this.connectionId = connectionId
  }
}
