/**
 * FRONTEND_URL is a comma-separated list (see `main.ts` CORS setup) so that
 * the apex (`https://databerry.app`) and the www subdomain
 * (`https://www.databerry.app`) can both be allowlisted from a single env
 * var. The browser treats them as distinct origins for CORS, so both must
 * appear there.
 *
 * For server-issued redirects (OAuth callbacks landing the user back on a
 * success/error page) we must pick a *single* URL — splatting the raw env
 * value into the redirect produces malformed URLs like
 * `https://a.app,https://b.app/hub/...`. Convention: the FIRST entry is the
 * canonical redirect target, the rest are CORS-only.
 */
export function getPrimaryFrontendUrl(): string {
  const first = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim()
  return first || 'http://localhost:3000'
}
