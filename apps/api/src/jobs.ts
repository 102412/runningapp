import { MediaCleanupJob, MediaDeleteObjectsJob, MediaProcessJob } from './modules/media/service';
import { SendEmailJob } from './platform/mail/service';
import { z } from 'zod';
import { PurgeFinishedJobsJob, purgeFinishedJobsHandler } from './platform/jobs/maintenance';
import { jobSpec } from './platform/jobs/queue';
import type { Schedule } from './platform/jobs/scheduler';
import { JobRegistry } from './platform/jobs/worker';
import type { Services } from './services';

export const PurgeAuthDataJob = jobSpec('auth.purge_expired', z.object({}), { maxAttempts: 3 });

/** Registers every background job handler and returns the recurring schedules. */
export function registerJobs(services: Services): { registry: JobRegistry; schedules: Schedule[] } {
  const { platform } = services;
  const registry = new JobRegistry();

  registry.register(PurgeFinishedJobsJob, purgeFinishedJobsHandler(platform.jobs, platform.clock));
  registry.register(SendEmailJob, services.mail.handleSendEmail);
  registry.register(PurgeAuthDataJob, () => services.auth.purgeExpired());
  registry.register(MediaProcessJob, services.media.handleProcess);
  registry.register(MediaDeleteObjectsJob, services.media.handleDeleteObjects);
  registry.register(MediaCleanupJob, services.media.handleCleanup);

  const schedules: Schedule[] = [
    { spec: PurgeFinishedJobsJob, payload: {}, everySeconds: 3600 },
    { spec: PurgeAuthDataJob, payload: {}, everySeconds: 3600 },
    { spec: MediaCleanupJob, payload: {}, everySeconds: 900 },
  ];
  return { registry, schedules };
}
