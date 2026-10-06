import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP-recommended minimums (19 MiB, t=2, p=1). Parameters are embedded in
 * each hash, so they can be raised later; `needsRehash` flags old hashes for upgrade on login.
 */
// `algorithm: 2` is Argon2id. The library's `Algorithm` is an ambient const enum, which cannot be
// imported under `verbatimModuleSyntax`, so the numeric value is used directly.
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function needsRehash(passwordHash: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
  if (!m) return true;
  return Number(m[1]) < OPTIONS.memoryCost || Number(m[2]) < OPTIONS.timeCost;
}

/**
 * A precomputed hash verified when the account does not exist, so login latency does not
 * reveal whether an email is registered.
 */
let dummyHash: Promise<string> | undefined;
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  return dummyHash.then((h) => verifyPassword(h, password));
}
