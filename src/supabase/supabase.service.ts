import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name)
  private client: SupabaseClient

  /**
   * Boot-time sanity check. Decodes the configured Supabase key and verifies
   * it's a `service_role` key — not the anon key. Why this matters: once any
   * `public` table has RLS enabled with no policies (intentional for backend-
   * only credential tables like `connections_google_analytics`), an anon-key
   * client gets *zero rows* on SELECT — silently, with no error. Symptoms
   * look exactly like missing data. This guard turns that footgun into a
   * loud startup log.
   */
  onModuleInit(): void {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) {
      this.logger.error('SUPABASE_SERVICE_ROLE_KEY is not set')
      return
    }
    const role = decodeJwtRole(key)
    if (role === 'service_role') {
      this.logger.log(`✓ Supabase key role=service_role (RLS bypass active)`)
    } else {
      this.logger.error(
        `✗ Supabase key role=${role ?? 'unknown'} — expected 'service_role'. ` +
          `RLS-protected tables will return EMPTY results. Fix the env var.`,
      )
    }
  }

  getClient(): SupabaseClient {
    if (!this.client) {
      this.client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    }
    return this.client
  }
}

/**
 * Pull the `role` claim out of a Supabase JWT without verifying the signature
 * (we don't have the secret, and we only need the role for diagnostics).
 * Returns null on any parse failure — caller treats null as 'unknown'.
 */
function decodeJwtRole(jwt: string): string | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}
