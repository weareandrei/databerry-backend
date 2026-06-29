# Stripe

## Connection

Two connection types:

- **Stripe Connect (OAuth)** — user authorizes via Stripe dashboard; access token stored in `connections_stripe`
- **Manual API key** — user pastes a secret key directly; stored in `connections_stripe_manual`

## How it works

- OAuth flow: user clicks "Connect Stripe" → redirected to Stripe → callback exchanges code for access token → stored with `stripe_account_id`
- Manual key flow: user pastes their Stripe secret key → stored in `connections_stripe_manual`
- Stripe sends payment events to `POST /webhooks/stripe` (signature verified with `STRIPE_WEBHOOK_SECRET`)
- `payment_intent.succeeded` events increment the daily revenue for matching views via `addToDailyRevenue`
- Live views call the Stripe Charges API on demand and cache the result via `ViewsService.upsertValue`

## Views

| View type | Strategy | Data source | Returns |
|-----------|----------|-------------|---------|
| `stripe_revenue_today` | Live | Stripe Charges API | Sum of succeeded charges since midnight UTC (cents) |
| `stripe_gross_today` | Live | Stripe Charges API | Hourly chart of charges for today |
| `stripe_gross_week` | Live | Stripe Charges API | Daily chart from Monday to today |

## Directory structure

```
stripe/
  connection/
    connection.module.ts
    connection.controller.ts   ← GET /stripe/oauth/start, GET /stripe/oauth/callback
    oauth.ts                   ← StripeOAuthService
  webhook/
    webhook.module.ts
    handler.ts                 ← StripeWebhookService.handleStripeEvent()
    events/
      payment-succeeded.ts     ← handlePaymentSucceeded() + addToDailyRevenue()
  views/
    views.module.ts
    views.controller.ts        ← GET /stripe/views/live-value, GET /stripe/views/chart-data
    views.service.ts           ← StripeViewsService
    stripe-api.client.ts       ← StripeApiClient, sumCharges(), fetchChargesSince()
    stripe-api.helpers.ts      ← getApiKey(), ChartPoint
    live/
      revenue-today.ts         ← computeRevenueToday()
      gross-today.ts           ← computeGrossToday()
      gross-week.ts            ← computeGrossWeek()
```
