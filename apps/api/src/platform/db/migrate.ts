import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Minimal forward-only SQL migration runner.
 *
 * - Migrations are plain `NNNN_name.sql` files applied in order, each in its own transaction.
 * - Applied migrations are recorded with a SHA-256 checksum; editing an applied file is an
 *   error (fix forward with a new migration instead).
 * - A session-level advisory lock serialises concurrent runners (e.g. several API replicas
 *   booting at once).
 */

const LOCK_KEY = 7_219_001;
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Locates `<package root>/migrations` by walking up from this file. Works unbundled
 * (src/platform/db) and bundled (dist/), as long as `migrations/` ships beside `dist/`.
 */
export function defaultMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the migrations directory');
    dir = parent;
  }
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (!match)
      throw new Error(`Invalid migration filename: ${name} (expected NNNN_snake_case.sql)`);
    const prefix = match[1] ?? '';
    if (seen.has(prefix)) throw new Error(`Duplicate migration number ${prefix}`);
    seen.add(prefix);
    const sql = await readFile(path.join(dir, name), 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

export async function migrate(
  pool: Pool,
  dir: string = defaultMigrationsDir(),
): Promise<MigrationResult> {
  const files = await loadMigrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations order by name',
    );
    const appliedByName = new Map(rows.map((r) => [r.name, r.checksum]));

    const known = new Set(files.map((f) => f.name));
    for (const name of appliedByName.keys()) {
      if (!known.has(name)) throw new Error(`Applied migration ${name} is missing from ${dir}`);
    }

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      const existing = appliedByName.get(file.name);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was modified after being applied. Add a new migration instead.`,
          );
        }
        result.alreadyApplied.push(file.name);
        continue;
      }
      try {
        await client.query('begin');
        await client.query(file.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw new Error(
          `Migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
      result.applied.push(file.name);
    }
    return result;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Readiness helper: true when every migration file has been applied. */
export async function migrationsUpToDate(
  pool: Pool,
  dir: string = defaultMigrationsDir(),
): Promise<boolean> {
  const files = await loadMigrationFiles(dir);
  const { rows } = await pool.query<{ count: string }>('select count(*) from schema_migrations');
  return Number(rows[0]?.count ?? 0) === files.length;
}
