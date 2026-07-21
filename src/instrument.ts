import * as Sentry from '@sentry/nestjs'

/**
 * Better Stack Error tracking via the Sentry SDK.
 * Must be imported before any other app modules (see main.ts).
 *
 * DSN format from Better Stack → Errors → Application → Data ingestion:
 *   https://$APPLICATION_TOKEN@$INGESTING_HOST/$APPLICATION_ID
 */
const dsn = process.env.BETTER_STACK_ERRORS_DSN?.trim()

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Capture 100% of transactions locally; dial down in production if noisy.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  })
}
