import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { LogEvent } from 'kysely';
import pg from 'pg';
import { buildApp } from '../../src/app';
import { loadConfig, type Config } from '../../src/config';
import { ManualClock } from '../../src/platform/clock';
import { createPlatform, type PlatformHandle } from '../../src/platform/create';
import { createServices, type ServiceOverrides, type Services } from '../../src/services';
import { adminUrl, TEMPLATE_DB, withDatabase } from './db-urls';

export interface TestApp {
  app: FastifyInstance;
  platform: PlatformHandle;
  services: Services;
  config: Config;
  clock: ManualClock;
  dbName: string;
  close(): Promise<void>;
}

export interface TestAppOptions {
  env?: Record<string, string>;
  clock?: ManualClock;
  /** Called for every SQL statement executed (used to assert query counts / N+1). */
  onQuery?: (event: LogEvent) => void;
  /** Replace adapters (mailer, storage, moderator, push) with test doubles. */
  overrides?: ServiceOverrides;
}

/** Creates an isolated database from the template and a fully wired app against it. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dbName = `runningapp_test_${randomBytes(6).toString('hex')}`;
  await createFromTemplate(dbName);

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: withDatabase(dbName),
    DATABASE_POOL_MAX: '5',
    RATE_LIMIT_ENABLED: 'false',
    WORKER_INLINE: 'false',
    AUTO_MIGRATE: 'false',
    DEV_AUTO_VERIFY_EMAIL: 'false',
    DEV_ENDPOINTS_ENABLED: 'true',
    LOCAL_STORAGE_DIR: `.local-storage/test-${dbName}`,
    ...options.env,
  });
  const clock = options.clock ?? new ManualClock(new Date());
  const platform = createPlatform(config, { clock, onQuery: options.onQuery });
  const services = createServices(platform, options.overrides);
  const app = await buildApp(platform, services);
  await app.ready();

  return {
    app,
    platform,
    services,
    config,
    clock,
    dbName,
    close: async () => {
      await app.close();
      await platform.close();
      const cleanup = new pg.Client({ connectionString: adminUrl() });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists "${dbName}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * CREATE DATABASE ... TEMPLATE fails with "source database is being accessed by other users" when
 * another worker is copying the same template at that instant. That is transient: retry briefly.
 */
async function createFromTemplate(dbName: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      await admin.query(`create database "${dbName}" template ${TEMPLATE_DB}`);
      return;
    } catch (err) {
      const busy = (err as { code?: string }).code === '55006';
      if (!busy || attempt >= 8) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.random() * 200));
    } finally {
      await admin.end();
    }
  }
}
