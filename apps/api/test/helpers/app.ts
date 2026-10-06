import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { LogEvent } from 'kysely';
import pg from 'pg';
import { buildApp } from '../../src/app';
import { loadConfig, type Config } from '../../src/config';
import { ManualClock } from '../../src/platform/clock';
import { createPlatform, type PlatformHandle } from '../../src/platform/create';
import { createServices, type Services } from '../../src/services';
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
}

/** Creates an isolated database from the template and a fully wired app against it. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dbName = `runningapp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`create database "${dbName}" template ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

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
  const services = createServices(platform);
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
