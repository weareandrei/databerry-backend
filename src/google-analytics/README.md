# Google Analytics

## Connection

**OAuth 2.0** — user authorizes via Google's OAuth consent screen. Access token and refresh token stored in `connections_google_analytics`. Tokens auto-refreshed before expiry.

## How it works

- User clicks "Connect Google Analytics" → `GET /google-analytics/oauth/start` builds the auth URL with `analytics.readonly` scope
- Google redirects to `GET /google-analytics/oauth/callback` → exchanges code for tokens, lists available GA4 properties
- If one property exists, it's saved automatically; if multiple, the user is redirected to a property picker (`select-property`)
- Access tokens expire after ~1 hour; `ensureFreshToken` checks expiry with a 5-minute buffer and refreshes via `refresh_token`
- Live views call the GA Data API or Realtime API on demand, then cache the result via `ViewsService.upsertValue`

## Views

| View type | Strategy | Data source | Returns |
|-----------|----------|-------------|---------|
| `ga_active_users` | Live | GA Realtime API (`runRealtimeReport`) | Current active users |
| `ga_users_today` | Live | GA Data API (`runReport`, today) | Total users today |
| `ga_sessions_today` | Live | GA Data API (`runReport`, today) | Sessions today |
| `ga_pageviews_today` | Live | GA Data API (`runReport`, today) | Page views today |

## Directory structure

```
google-analytics/
  connection/
    connection.module.ts
    connection.controller.ts   ← GET/PATCH /google-analytics/oauth/start|callback|properties|property
    oauth.ts                   ← GoogleAnalyticsOAuthService (OAuth flow + token refresh + property lookup)
    properties.ts              ← GoogleAnalyticsPropertiesService (getProperties, saveProperty)
  views/
    views.module.ts
    views.controller.ts        ← GET /google-analytics/views/live-value
    views.service.ts           ← GoogleAnalyticsViewsService
    live/
      metrics.ts               ← fetchRealtimeActiveUsers(), fetchTodayMetric(), metricForViewType()
```
