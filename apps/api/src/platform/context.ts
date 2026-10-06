import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { Clock } from './clock';
import type { Db } from './db/client';
import type { JobQueue } from './jobs/queue';
import type { Metrics } from './metrics/metrics';

/**
 * Cross-cutting infrastructure handed to every module. Modules never construct their own DB
 * pools, clocks or loggers, which is what makes them testable and extractable.
 */
export interface PlatformContext {
  config: Config;
  db: Db;
  pool: Pool;
  clock: Clock;
  logger: FastifyBaseLogger;
  jobs: JobQueue;
  metrics: Metrics;
}
