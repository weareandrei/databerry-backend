/**
 * Application-layer encryption envelope for sensitive credentials
 * stored in Supabase (OAuth tokens, API keys).
 *
 * ──────────────────────────────────────────────────────────────────
 * Algorithm choices
 * ──────────────────────────────────────────────────────────────────
 *
 *   - **AES-256-GCM** for the symmetric cipher. Authenticated
 *     encryption (the auth tag detects tampering); industry
 *     standard; built into Node — no new dependency.
 *   - **HKDF-SHA256** to derive a per-user 32-byte AES key from a
 *     single master `ENCRYPTION_KEY` plus the Supabase user UUID.
 *     RFC 5869, also built into Node.
 *   - **Random 12-byte IV per encryption**, stored alongside the
 *     ciphertext. AES-GCM's standard IV size.
 *   - **Versioned wire format** `v1:<iv>.<tag>.<ciphertext>` (each
 *     segment base64url-encoded). The `v1:` prefix lets us migrate
 *     to v2 in the future without ambiguity, and lets the
 *     migration script + read paths cheaply detect "already
 *     encrypted? skip / accept" vs. "legacy plaintext".
 *
 * ──────────────────────────────────────────────────────────────────
 * Why per-user derivation
 * ──────────────────────────────────────────────────────────────────
 *
 * The user UUID isn't technically secret (it's in cookies, JWTs,
 * the DB itself), so this isn't extra-strong cryptography — it's
 * defense-in-depth + strict context binding:
 *
 *   - An attacker with `ENCRYPTION_KEY` + a SQL dump still has to
 *     pair each row with its owning user's UUID before they can
 *     decrypt. The master key alone is not enough.
 *   - More importantly, every read+write site is *forced* to know
 *     which user owns the row. A bug that swaps user IDs across
 *     rows results in a decryption failure (GCM auth tag mismatch)
 *     instead of silently returning the wrong user's data. GCM is
 *     the safety net.
 *
 * ──────────────────────────────────────────────────────────────────
 * Operational notes
 * ──────────────────────────────────────────────────────────────────
 *
 *   - `ENCRYPTION_KEY` must be a 64-character hex string (32 raw
 *     bytes). Generate with `openssl rand -hex 32`.
 *   - The same value must be used in production forever. Loss of
 *     the master key = loss of every stored credential. There is
 *     no recovery path; the user has to reconnect each integration.
 *   - This module fails at import time if `ENCRYPTION_KEY` is
 *     missing or malformed, so a misconfigured deploy crashes
 *     loudly at boot rather than silently misencrypting later.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

// ── Master key — loaded once at process start ─────────────────────────────

/**
 * 32 raw bytes. Throws at module import if the env var is missing
 * or malformed — preferred over silently falling back to a default
 * key (which would mis-encrypt every write).
 */
const MASTER_KEY: Buffer = (() => {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY env var not set. Generate one with `openssl rand -hex 32` ' +
        'and add it to backend/.env (and Railway env vars in production).',
    )
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex chars (32 bytes); got ${hex.length} chars. ` +
        'Generate with `openssl rand -hex 32`.',
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be hex-encoded (0-9, a-f).')
  }
  return Buffer.from(hex, 'hex')
})()

/**
 * HKDF salt. The master key is the secret; the salt's role is just
 * to differentiate this app's HKDF output from any other use of the
 * same primitive (RFC 5869 explicitly allows a non-secret salt).
 *
 * Bumping the version suffix (`-v1` → `-v2`) is a way to rotate
 * derived keys without rotating the master key — only useful as a
 * future option; for now the value is fixed.
 */
const HKDF_SALT = Buffer.from('databerry-credential-encryption-v1', 'utf8')

// ── Per-user key derivation ────────────────────────────────────────────────

/**
 * Derive a 32-byte AES-256 key for a specific user from the master
 * key. Same master key + same user UUID always yields the same
 * derived key (deterministic), so we don't need to persist anything
 * extra per row beyond the IV / tag / ciphertext that AES-GCM
 * already stores.
 *
 * The user UUID is passed as the HKDF `info` parameter — that's the
 * RFC's "context" hook, exactly the right place for binding a
 * derived key to a specific entity.
 */
function deriveUserKey(userId: string): Buffer {
  if (!userId || typeof userId !== 'string') {
    throw new Error('deriveUserKey: userId must be a non-empty string')
  }
  const derived = hkdfSync('sha256', MASTER_KEY, HKDF_SALT, userId, 32)
  // hkdfSync returns ArrayBuffer; coerce to Node Buffer for the
  // downstream `createCipheriv` call which prefers Buffer/string.
  return Buffer.from(derived)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` for the given user. Returns a self-describing
 * `v1:` string that's safe to store as TEXT in Postgres (base64url
 * is URL-safe and DB-safe).
 *
 * Idempotency note: this is NOT idempotent — calling it twice on
 * the same input produces different ciphertexts because the IV is
 * randomised per call. That's the correct AES-GCM behaviour; an
 * adversary watching the DB can't tell that two rows have the same
 * underlying token.
 */
export function encryptForUser(plaintext: string, userId: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptForUser: plaintext must be a string')
  }
  const key = deriveUserKey(userId)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1:',
    iv.toString('base64url'),
    '.',
    tag.toString('base64url'),
    '.',
    ciphertext.toString('base64url'),
  ].join('')
}

/**
 * Decrypt a `v1:` ciphertext for the given user. Throws if:
 *   - the input doesn't have the `v1:` prefix (caller should check
 *     `isEncrypted` first if the column might still hold legacy
 *     plaintext during the migration window),
 *   - the format is malformed,
 *   - the auth tag doesn't verify (tampering, wrong user, wrong
 *     master key, corruption — the message intentionally doesn't
 *     distinguish between these so an attacker can't probe).
 */
export function decryptForUser(ciphertext: string, userId: string): string {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith('v1:')) {
    throw new Error('decryptForUser: ciphertext missing v1: version prefix')
  }
  const body = ciphertext.slice('v1:'.length)
  const parts = body.split('.')
  if (parts.length !== 3) {
    throw new Error('decryptForUser: malformed v1 ciphertext (expected iv.tag.ct)')
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const ct = Buffer.from(ctB64, 'base64url')
  const key = deriveUserKey(userId)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Format detector — `true` when the value is a `v1:` ciphertext
 * produced by this module, `false` for plaintext / null / malformed.
 *
 * Used in two places:
 *   - The migration script, to skip rows that have already been
 *     encrypted (so the script is idempotent + safe to re-run).
 *   - Read paths during the migration window, to gracefully accept
 *     either format. Once the migration completes + the codebase is
 *     re-deployed without the fallback, this can be retired.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('v1:')
}
