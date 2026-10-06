import { sql, type RawBuilder } from 'kysely';

/**
 * Keyset-pagination helpers.
 *
 * JavaScript Dates carry milliseconds but PostgreSQL timestamptz carries microseconds. A cursor
 * that round-trips a timestamp through a JS Date would collapse distinct rows onto the same
 * instant and skip or repeat items. So timestamps used in cursors travel as full-precision text.
 */

/** Selects a timestamptz as an ISO-8601 string with microsecond precision. */
export function timestampText(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `(column, idColumn) < (cursorTs, cursorId)` for descending (newest-first) listings. */
export function keysetBefore(
  column: string,
  idColumn: string,
  cursor: { t: string; id: string },
): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(column)}, ${sql.ref(idColumn)}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`;
}
