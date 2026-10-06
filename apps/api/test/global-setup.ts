import pg from 'pg';
import { migrate } from '../src/platform/db/migrate';
import { adminUrl, TEMPLATE_DB, withDatabase } from './helpers/db-urls';

/**
 * Builds a fully-migrated template database once per `vitest` run. Each test file then clones
 * it with `CREATE DATABASE ... TEMPLATE` (milliseconds), giving real-Postgres isolation
 * without re-running migrations per file.
 */
export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await dropStaleTestDatabases(admin);
    await admin.query(`create database ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: withDatabase(TEMPLATE_DB), max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await dropStaleTestDatabases(admin);
  } finally {
    await admin.end();
  }
}

async function dropStaleTestDatabases(admin: pg.Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `select datname from pg_database where datname like 'runningapp\\_test\\_%'`,
  );
  for (const { datname } of rows) {
    await admin.query(`drop database if exists "${datname}" with (force)`);
  }
}
