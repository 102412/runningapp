/** Helpers for interpreting PostgreSQL driver errors (pg's DatabaseError). */
interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgErrorLike {
  return typeof err === 'object' && err !== null ? err : {};
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = asPgError(err);
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const e = asPgError(err);
  return e.code === '23503' && (constraint === undefined || e.constraint === constraint);
}

/** Raised by the `reject_relationship_across_block` trigger. */
export function isBlockedPairViolation(err: unknown): boolean {
  const e = asPgError(err);
  return e.code === 'P0001' && e.constraint === 'blocked_pair';
}
