import { CamelCasePlugin, Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { DB } from './generated';

// `date` columns (e.g. birth_date) must stay calendar strings, never JS Dates in local TZ.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
// int8 is only used for counters/sizes well below 2^53; parse to number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Db = Kysely<DB>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  poolMax?: number;
  ssl?: boolean;
  /** Called for every executed query (used by tests to assert query counts). */
  onQuery?: (event: LogEvent) => void;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    // Fail fast instead of hanging requests behind a saturated pool.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => undefined);

  const onQuery = options.onQuery;
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
    log: onQuery
      ? (event) => {
          if (event.level === 'query') onQuery(event);
        }
      : undefined,
  });

  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}
