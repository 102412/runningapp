import {
  MediaCleanupJob,
  MediaDeleteObjectsJob,
  MediaProcessJob,
  MediaStatusChangedJob,
} from './modules/media/service';
import {
  PurgeAnalyticsJob,
  RefreshAffinitiesJob,
  RollupPostStatsJob,
} from './modules/feed/analytics';
import { ExportBuildJob, ExportExpireJob } from './modules/exports/service';
import { PurgeDueAccountsJob } from './flows/purge-account';
import { PushNotificationJob } from './modules/notifier';
import { SendEmailJob } from './platform/mail/service';
import { z } from 'zod';
import { PurgeFinishedJobsJob, purgeFinishedJobsHandler } from './platform/jobs/maintenance';
import { jobSpec } from './platform/jobs/queue';
import type { Schedule } from './platform/jobs/scheduler';
import { JobRegistry } from './platform/jobs/worker';
import type { Services } from './services';

export const PurgeDeletedPostsJob = jobSpec('posts.purge_deleted', z.object({}), {
  maxAttempts: 3,
});
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
  registry.register(MediaStatusChangedJob, services.posts.handleMediaStatusChanged);
  registry.register(PurgeDeletedPostsJob, services.posts.handlePurgeDeleted);
  registry.register(PushNotificationJob, services.notifications.handlePush);
  registry.register(RollupPostStatsJob, services.feedAnalytics.handleRollup);
  registry.register(RefreshAffinitiesJob, services.feedAnalytics.handleAffinities);
  registry.register(PurgeAnalyticsJob, services.feedAnalytics.handlePurge);
  registry.register(ExportBuildJob, services.dataExports.handleBuild);
  registry.register(ExportExpireJob, services.dataExports.handleExpire);
  registry.register(PurgeDueAccountsJob, services.accountPurger.handlePurgeDue);

  const schedules: Schedule[] = [
    { spec: PurgeFinishedJobsJob, payload: {}, everySeconds: 3600 },
    { spec: PurgeAuthDataJob, payload: {}, everySeconds: 3600 },
    { spec: MediaCleanupJob, payload: {}, everySeconds: 900 },
    { spec: PurgeDeletedPostsJob, payload: {}, everySeconds: 6 * 3600 },
    { spec: RollupPostStatsJob, payload: {}, everySeconds: 300 },
    { spec: RefreshAffinitiesJob, payload: {}, everySeconds: 300 },
    { spec: PurgeAnalyticsJob, payload: {}, everySeconds: 6 * 3600 },
    { spec: ExportExpireJob, payload: {}, everySeconds: 3600 },
    { spec: PurgeDueAccountsJob, payload: {}, everySeconds: 900 },
  ];
  return { registry, schedules };
}
