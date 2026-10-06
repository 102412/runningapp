import { pino } from 'pino';
import type { LogEvent } from 'kysely';
import type { Config } from '../config';
import { systemClock, type Clock } from './clock';
import { createDb } from './db/client';
import { JobQueue } from './jobs/queue';
import { buildLoggerOptions } from './logging';
import { Metrics } from './metrics/metrics';
import type { PlatformContext } from './context';

export interface PlatformHandle extends PlatformContext {
  close(): Promise<void>;
}

export interface CreatePlatformOptions {
  clock?: Clock;
  onQuery?: (event: LogEvent) => void;
}

/** Builds the shared infrastructure (DB pool, queue, logger, metrics) from config. */
export function createPlatform(
  config: Config,
  options: CreatePlatformOptions = {},
): PlatformHandle {
  const clock = options.clock ?? systemClock;
  const logger = pino(buildLoggerOptions(config));
  const handle = createDb({
    url: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
    onQuery: options.onQuery,
  });
  return {
    config,
    db: handle.db,
    pool: handle.pool,
    clock,
    logger,
    jobs: new JobQueue(handle.db, clock),
    metrics: new Metrics(handle.pool),
    close: () => handle.close(),
  };
}
