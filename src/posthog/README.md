# PostHog

## Connection

**API Key** — user provides a PostHog Personal API key, project ID, and host (defaults to `https://app.posthog.com`). Stored in `connections_posthog`.

## How it works

- Connection is created manually (user pastes credentials) — no OAuth flow
- When a PostHog view is created, a **Hog Function** (PostHog Destination) is registered in the user's project that sends a webhook to `POST /webhooks/posthog/:connectionId/:viewId` for every matching event
- The webhook handler increments a `daily_counter` in `views_values` for each incoming event
- When a view is deleted, the Hog Function is soft-deleted in PostHog (`PATCH hog_functions/:id` with `{ deleted: true }`)
- Event definitions (for the view creation UI) are fetched on demand from the PostHog Event Definitions API

## Views

| View type | Strategy | Data source | Returns |
|-----------|----------|-------------|---------|
| `daily_counter` | Webhook | PostHog Hog Function → `POST /webhooks/posthog/:connectionId/:viewId` | Daily count of matched events |

## Directory structure

```
posthog/
  connection/
    connection.module.ts
    credentials.ts             ← PosthogCredentialsService + getPosthogCredentials() + getEventDefinitions()
  lifecycle/
    lifecycle.module.ts
    hog-function.ts            ← PosthogLifecycleService (createHogFunction, deleteHogFunction)
  webhook/
    webhook.module.ts
    handler.ts                 ← PosthogWebhookService (handlePosthogEvent, incrementDailyCounter)
```
