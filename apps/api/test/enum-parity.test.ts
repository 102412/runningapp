import { DB_ENUM_PARITY, SPORT_KEYS } from '@runningapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

/** Enums that exist only inside the database/server and are intentionally not in the contract. */
const INTERNAL_DB_ENUMS = new Set([
  'job_status',
  'auth_token_purpose',
  'oauth_provider',
  'affinity_subject',
]);

describe('contract <-> database parity', () => {
  let t: TestApp;
  let dbEnums: Map<string, string[]>;
  beforeAll(async () => {
    t = await createTestApp();
    const rows = await t.platform.pool.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
        group by t.typname`,
    );
    dbEnums = new Map(rows.rows.map((r) => [r.typname, r.labels]));
  });
  afterAll(async () => {
    await t.close();
  });

  it('every shared enum exists in the database with exactly the contract values', () => {
    for (const [name, values] of Object.entries(DB_ENUM_PARITY)) {
      const db = dbEnums.get(name);
      expect(
        db,
        `enum ${name} is declared in the contract but missing from the database`,
      ).toBeDefined();
      expect([...(db ?? [])].sort(), `enum ${name}`).toEqual([...values].sort());
    }
  });

  it('no database enum is left out of both the contract and the internal allow-list', () => {
    const unaccounted = [...dbEnums.keys()].filter(
      (n) => !(n in DB_ENUM_PARITY) && !INTERNAL_DB_ENUMS.has(n),
    );
    expect(unaccounted).toEqual([]);
  });

  it('SPORT_KEYS matches the seeded sports table', async () => {
    const rows = await t.platform.db.selectFrom('sports').select('key').execute();
    expect(rows.map((r) => r.key).sort()).toEqual([...SPORT_KEYS].sort());
  });
});
