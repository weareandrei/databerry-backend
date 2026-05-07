/**
 * Smoke test for the credential-encryption module.
 *
 * Sets `ENCRYPTION_KEY` BEFORE importing the module under test —
 * the module's import-time validation throws if it isn't there, so
 * we can't use the standard top-of-file import pattern.
 */

// 64 hex chars (32 bytes). Random; the value doesn't matter — any
// 256-bit value works. Real production uses `openssl rand -hex 32`.
process.env.ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptForUser, decryptForUser, isEncrypted } = require('./encryption') as typeof import('./encryption')

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

describe('encryption', () => {
  describe('round-trip', () => {
    it('encrypts + decrypts back to the same plaintext for the same user', () => {
      const original = 'sk_test_some_secret_api_key_value_xyz'
      const encrypted = encryptForUser(original, USER_A)
      expect(encrypted.startsWith('v1:')).toBe(true)
      expect(encrypted).not.toContain(original)
      expect(decryptForUser(encrypted, USER_A)).toBe(original)
    })

    it('handles empty strings, unicode, and long values', () => {
      for (const sample of [
        '',
        'plain ascii',
        'unicode 日本語 emoji 🔐',
        'a'.repeat(10_000),
      ]) {
        const ciphertext = encryptForUser(sample, USER_A)
        expect(decryptForUser(ciphertext, USER_A)).toBe(sample)
      }
    })

    it('produces different ciphertext on each call (IV randomisation)', () => {
      const a = encryptForUser('same-input', USER_A)
      const b = encryptForUser('same-input', USER_A)
      expect(a).not.toBe(b)
      // …but both decrypt back to the same plaintext.
      expect(decryptForUser(a, USER_A)).toBe('same-input')
      expect(decryptForUser(b, USER_A)).toBe('same-input')
    })
  })

  describe('cross-user isolation', () => {
    it('refuses to decrypt with a different userId (auth tag mismatch)', () => {
      const encrypted = encryptForUser('alice-secret', USER_A)
      // GCM's auth tag binds the ciphertext to the derived key. A
      // different userId derives a different key, which fails the
      // tag check at `final()`.
      expect(() => decryptForUser(encrypted, USER_B)).toThrow()
    })

    it('produces visibly different ciphertext for different users with same plaintext', () => {
      const aliceCt = encryptForUser('shared-input', USER_A)
      const bobCt = encryptForUser('shared-input', USER_B)
      expect(aliceCt).not.toBe(bobCt)
    })
  })

  describe('tamper detection', () => {
    it('refuses to decrypt a ciphertext whose body has been mutated', () => {
      const original = encryptForUser('something-sensitive', USER_A)
      // Flip a character in the ciphertext segment (last `.`-segment).
      const idx = original.lastIndexOf('.')
      const flipped =
        original.slice(0, idx + 2) +
        (original.charAt(idx + 2) === 'A' ? 'B' : 'A') +
        original.slice(idx + 3)
      expect(flipped).not.toBe(original)
      expect(() => decryptForUser(flipped, USER_A)).toThrow()
    })

    it('refuses to decrypt a ciphertext whose tag has been mutated', () => {
      const original = encryptForUser('something-sensitive', USER_A)
      // The tag segment is between the first and second `.` after `v1:`.
      const firstDot = original.indexOf('.')
      const secondDot = original.indexOf('.', firstDot + 1)
      const tagChar = original.charAt(firstDot + 1)
      const flipped =
        original.slice(0, firstDot + 1) +
        (tagChar === 'A' ? 'B' : 'A') +
        original.slice(firstDot + 2, secondDot) +
        original.slice(secondDot)
      expect(() => decryptForUser(flipped, USER_A)).toThrow()
    })
  })

  describe('format detection', () => {
    it('isEncrypted returns true for v1: ciphertext, false otherwise', () => {
      expect(isEncrypted(encryptForUser('x', USER_A))).toBe(true)
      expect(isEncrypted('plaintext-secret')).toBe(false)
      expect(isEncrypted('v2:future-format')).toBe(false)
      expect(isEncrypted('')).toBe(false)
      expect(isEncrypted(null)).toBe(false)
      expect(isEncrypted(undefined)).toBe(false)
    })

    it('decryptForUser rejects non-v1 input rather than silently passing through', () => {
      expect(() => decryptForUser('plaintext', USER_A)).toThrow(/v1: version prefix/)
      expect(() => decryptForUser('v1:malformed', USER_A)).toThrow(/malformed/)
    })
  })
})
