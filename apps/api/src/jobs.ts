import { PurgeFinishedJobsJob, purgeFinishedJobsHandler } from './platform/jobs/maintenance';
import type { Schedule } from './platform/jobs/scheduler';
import { JobRegistry } from './platform/jobs/worker';
import type { Services } from './services';

/** Registers every background job handler and returns the recurring schedules. */
export function registerJobs(services: Services): { registry: JobRegistry; schedules: Schedule[] } {
  const { platform } = services;
  const registry = new JobRegistry();
  registry.register(PurgeFinishedJobsJob, purgeFinishedJobsHandler(platform.jobs, platform.clock));

  const schedules: Schedule[] = [{ spec: PurgeFinishedJobsJob, payload: {}, everySeconds: 3600 }];
  return { registry, schedules };
}
