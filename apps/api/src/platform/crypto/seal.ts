import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing for short-lived secrets that must transit the database (e.g. a raw email
 * verification token inside a queued job payload). Keys are derived from the app secret with
 * HKDF, so the database alone is not enough to recover them.
 */
function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'runningapp-seal-v1', 'job-payload', 32));
}

export function seal(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** Tries each secret in order (current, then previous) so rotation does not strand queued jobs. */
export function unseal(secrets: readonly string[], sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      /* try the next secret */
    }
  }
  throw new Error('Unable to unseal value with any configured secret');
}
