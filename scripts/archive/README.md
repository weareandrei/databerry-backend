# Archived one-time scripts

Completed migrations kept for reference — all idempotent, all already
applied to production:

- `encrypt-existing-credentials.ts` — encrypted plaintext connection
  credentials with per-user AES keys (applied 2026-05-09).
- `verify-encrypted-credentials.ts` — post-encryption verification
  companion for the above.
- `migrate-view-types-2026-05.ts` — renamed legacy view types
  (`stripe_revenue_today` → `stripe_gross`) + seeded `displayMode`
  (applied 2026-05-08).

Live SQL migrations stay in `scripts/` until applied to every
environment; see each file's header for run order.
