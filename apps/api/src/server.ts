import { loadConfig, loadDotEnv } from './config';
import { buildApp } from './app';
import { registerJobs } from './jobs';
import { migrate } from './platform/db/migrate';
import { createPlatform } from './platform/create';
import { JobWorker } from './platform/jobs/worker';
import { Scheduler } from './platform/jobs/scheduler';
import { createServices } from './services';

loadDotEnv();
const config = loadConfig();
const platform = createPlatform(config);
const { logger } = platform;

if (config.AUTO_MIGRATE) {
  const result = await migrate(platform.pool);
  if (result.applied.length > 0) logger.info({ applied: result.applied }, 'applied migrations');
}

const services = createServices(platform);
const app = await buildApp(platform, services);

let worker: JobWorker | undefined;
let scheduler: Scheduler | undefined;
if (config.WORKER_INLINE) {
  const { registry, schedules } = registerJobs(services);
  worker = new JobWorker(platform.jobs, registry, {
    concurrency: config.WORKER_CONCURRENCY,
    logger,
    metrics: platform.metrics,
  });
  scheduler = new Scheduler(platform.jobs, schedules, platform.clock, logger);
  worker.start();
  scheduler.start();
  logger.info('inline job worker started');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  try {
    scheduler?.stop();
    await app.close(); // stops accepting, drains in-flight requests
    await worker?.stop(); // lets running jobs finish
    await platform.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
