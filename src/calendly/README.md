# Calendly

## Connection

**OAuth 2.0 with PKCE** — user authorizes via Calendly's OAuth flow. Tokens stored in `connections_calendly`, auto-refreshed before expiry.

## How it works

- User clicks "Connect Calendly" → `GET /calendly/oauth/start` generates a PKCE code challenge and state, stores them in `calendly_oauth_state`
- Calendly redirects to `GET /calendly/oauth/callback` → exchanges code for access + refresh tokens
- Connection record created in `connections` + credentials in `connections_calendly`
- Access tokens expire; `ensureFreshToken` checks expiry and refreshes automatically (5-minute buffer)
- Live views fetch active scheduled events from the Calendly API on demand

## Views

| View type | Strategy | Data source | Returns |
|-----------|----------|-------------|---------|
| `calendly_meetings_today` | Live | Calendly Scheduled Events API | Count of active events today (string) |
| `calendly_meetings_list` | Live | Calendly Scheduled Events + Invitees API | Array of meeting objects with invitees |

## Directory structure

```
calendly/
  connection/
    connection.module.ts
    connection.controller.ts   ← GET /calendly/oauth/start, GET /calendly/oauth/callback
    oauth.ts                   ← CalendlyOAuthService (getOAuthUrl, handleOAuthCallback, ensureFreshToken, getUserUri, verifyOwnership)
  views/
    views.module.ts
    views.controller.ts        ← GET /calendly/views/live-value, GET /calendly/views/meetings-list
    views.service.ts           ← CalendlyViewsService
    live/
      meetings-today.ts        ← computeMeetingsToday() + getTodayEvents()
      meetings-list.ts         ← computeMeetingsList()
```
