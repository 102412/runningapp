import type { z } from 'zod';
import { AppError } from '../errors';

/**
 * Opaque pagination cursors. Clients treat them as black boxes. They are not secret and not
 * signed: a forged cursor can only change *where* a listing starts, and every listing query
 * re-applies visibility filtering, so tampering cannot expose anything.
 */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(raw: string, schema: S): z.output<S> {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  throw new AppError('INVALID_CURSOR');
}

/**
 * Standard "fetch limit+1" pagination: given up to `limit + 1` rows, returns the page and
 * whether a further page exists.
 */
export function sliceProbe<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
