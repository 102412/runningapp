import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrationFiles, migrate } from '../src/platform/db/migrate';
import { createTestApp, type TestApp } from './helpers/app';
import { adminUrl, withDatabase } from './helpers/db-urls';

describe('migration runner', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('real migrations are well-formed and re-runnable (idempotent)', async () => {
    const files = await loadMigrationFiles(defaultMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    const pool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 2 });
    try {
      const result = await migrate(pool);
      expect(result.applied).toEqual([]); // the template already applied everything
      expect(result.alreadyApplied).toHaveLength(files.length);
    } finally {
      await pool.end();
    }
  });

  describe('on a scratch database', () => {
    const scratch = `runningapp_test_mig_${process.pid}_${Date.now()}`;
    let admin: pg.Client;
    let pool: pg.Pool;
    let dir: string;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: adminUrl() });
      await admin.connect();
      await admin.query(`create database "${scratch}"`);
      pool = new pg.Pool({ connectionString: withDatabase(scratch), max: 4 });
      pool.on('error', () => undefined);
      dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`drop database if exists "${scratch}" with (force)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    });

    it('applies in order, then refuses if an applied file is edited', async () => {
      await writeFile(path.join(dir, '0001_a.sql'), 'create table a (id int);');
      expect((await migrate(pool, dir)).applied).toEqual(['0001_a.sql']);

      await writeFile(path.join(dir, '0001_a.sql'), 'create table a (id int, extra int);');
      await expect(migrate(pool, dir)).rejects.toThrow(/modified after being applied/);
      await writeFile(path.join(dir, '0001_a.sql'), 'create table a (id int);'); // restore
    });

    it('rolls a failing migration back completely and does not record it', async () => {
      await writeFile(
        path.join(dir, '0002_bad.sql'),
        'create table b (id int); select * from does_not_exist;',
      );
      await expect(migrate(pool, dir)).rejects.toThrow(/0002_bad\.sql failed/);
      const { rows } = await pool.query<{ b: string | null }>(
        `select to_regclass('public.b')::text as b`,
      );
      expect(rows[0]?.b).toBeNull();
      await rm(path.join(dir, '0002_bad.sql'));
    });

    it('serialises concurrent runners so nothing is applied twice', async () => {
      await writeFile(path.join(dir, '0002_ok.sql'), 'create table c (id int);');
      const results = await Promise.all([
        migrate(pool, dir),
        migrate(pool, dir),
        migrate(pool, dir),
      ]);
      expect(results.flatMap((r) => r.applied)).toEqual(['0002_ok.sql']);
    });

    it('rejects malformed filenames and duplicate numbers', async () => {
      const bad = await mkdtemp(path.join(os.tmpdir(), 'migrations-bad-'));
      try {
        await writeFile(path.join(bad, 'init.sql'), 'select 1;');
        await expect(loadMigrationFiles(bad)).rejects.toThrow(/Invalid migration filename/);
        await rm(path.join(bad, 'init.sql'));
        await writeFile(path.join(bad, '0001_a.sql'), 'select 1;');
        await writeFile(path.join(bad, '0001_b.sql'), 'select 1;');
        await expect(loadMigrationFiles(bad)).rejects.toThrow(/Duplicate migration number/);
      } finally {
        await rm(bad, { recursive: true, force: true });
      }
    });
  });
});
