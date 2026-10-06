import { loadConfig } from './config';
import { registerJobs } from './jobs';
import { migrate } from './platform/db/migrate';
import { createPlatform } from './platform/create';
import { JobWorker } from './platform/jobs/worker';
import { Scheduler } from './platform/jobs/scheduler';
import { createServices } from './services';

// Standalone worker process: same code and config as the API, no HTTP listener.
const config = loadConfig();
const platform = createPlatform(config);
const { logger } = platform;

if (config.AUTO_MIGRATE) await migrate(platform.pool);

const services = createServices(platform);
const { registry, schedules } = registerJobs(services);
const worker = new JobWorker(platform.jobs, registry, {
  concurrency: config.WORKER_CONCURRENCY,
  logger,
  metrics: platform.metrics,
});
const scheduler = new Scheduler(platform.jobs, schedules, platform.clock, logger);
worker.start();
scheduler.start();
logger.info({ jobs: registry.names() }, 'worker started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  scheduler.stop();
  await worker.stop();
  await platform.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
