import { randomBytes } from 'node:crypto';

/**
 * UUIDv7: 48-bit unix-ms timestamp + randomness. Time-ordered IDs keep btree inserts
 * append-mostly and make `ORDER BY id` approximate `ORDER BY created_at`.
 * The database has an equivalent `uuid_generate_v7()` default for SQL-side inserts.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  b[0] = (nowMs / 2 ** 40) & 0xff;
  b[1] = (nowMs / 2 ** 32) & 0xff;
  b[2] = (nowMs / 2 ** 24) & 0xff;
  b[3] = (nowMs / 2 ** 16) & 0xff;
  b[4] = (nowMs / 2 ** 8) & 0xff;
  b[5] = nowMs & 0xff;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The smallest UUIDv7-ordered value for a millisecond: every id generated before that instant
 * sorts below it. Used as an exclusive upper bound ("settled" events) when scanning by id.
 */
export function uuidv7Floor(ms: number): string {
  const hex = Math.floor(ms).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
