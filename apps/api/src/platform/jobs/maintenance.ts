import { z } from 'zod';
import type { Clock } from '../clock';
import { jobSpec, type JobQueue } from './queue';

export const PurgeFinishedJobsJob = jobSpec('platform.purge_finished_jobs', z.object({}), {
  maxAttempts: 3,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keeps the jobs table small: successes live 7 days (debugging), dead letters 30 days. */
export function purgeFinishedJobsHandler(queue: JobQueue, clock: Clock) {
  return async (): Promise<void> => {
    const now = clock.now().getTime();
    await queue.purgeFinished(new Date(now - 7 * DAY_MS), new Date(now - 30 * DAY_MS));
  };
}
