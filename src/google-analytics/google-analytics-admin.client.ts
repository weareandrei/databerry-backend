import { Logger } from '@nestjs/common'
import {
  fmtFailure,
  fmtOp,
  fmtUpstreamFailure,
  type LogContext,
} from '../common/log-helpers'

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta'

export interface GAProperty {
  id: string
  name: string
  displayName: string
}

/**
 * Authenticated HTTP client for the GA Admin API. One instance per access
 * token — never a Nest singleton.
 */
export class GoogleAnalyticsAdminClient {
  private readonly logger = new Logger(GoogleAnalyticsAdminClient.name)

  constructor(private readonly accessToken: string) {}

  /**
   * Lists every GA4 property the bearer token has access to.
   * Never throws — failures log and return partial results (or `[]`).
   */
  async listProperties(ctx: LogContext = {}): Promise<GAProperty[]> {
    const all: GAProperty[] = []
    try {
      const accRes = await fetch(`${ADMIN_BASE}/accounts`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      })
      if (!accRes.ok) {
        const body = await accRes.text().catch(() => '')
        this.logger.warn(fmtUpstreamFailure('list GA accounts', accRes.status, body, ctx))
        if (accRes.status === 403 && body.includes('SERVICE_DISABLED')) {
          const activationUrl = body.match(
            /https:\/\/console\.developers\.google\.com\/apis\/api\/[^"\s]+/,
          )?.[0]
          this.logger.warn(
            fmtOp('GA Admin API is disabled in the OAuth Cloud project', {
              ...ctx,
              ...(activationUrl ? { enableAt: activationUrl } : {}),
            }),
          )
        }
        return []
      }
      const accData = (await accRes.json()) as { accounts?: { name: string }[] }

      for (const account of accData.accounts ?? []) {
        const propRes = await fetch(
          `${ADMIN_BASE}/properties?filter=ancestor:${account.name}&pageSize=200`,
          { headers: { Authorization: `Bearer ${this.accessToken}` } },
        )
        if (!propRes.ok) {
          const body = await propRes.text().catch(() => '')
          this.logger.warn(
            fmtUpstreamFailure('list GA properties', propRes.status, body, {
              ...ctx,
              account: account.name,
            }),
          )
          continue
        }
        const propData = (await propRes.json()) as {
          properties?: { name: string; displayName: string }[]
        }
        for (const p of propData.properties ?? []) {
          const id = p.name.split('/').pop()!
          all.push({ id, name: p.name, displayName: p.displayName })
        }
      }
    } catch (err) {
      this.logger.error(fmtFailure('list GA properties', err, ctx))
    }
    return all
  }
}
