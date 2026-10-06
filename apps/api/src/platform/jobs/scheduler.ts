import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { Clock } from '../clock';
import type { JobQueue, JobSpec } from './queue';

export interface Schedule<S extends z.ZodType = z.ZodType> {
  spec: JobSpec<S>;
  payload: z.input<S>;
  everySeconds: number;
}

/**
 * Enqueues recurring jobs. Each (job, time-bucket) pair has a globally unique key, so any
 * number of scheduler instances produce exactly one job per bucket.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly queue: JobQueue,
    private readonly schedules: Schedule[],
    private readonly clock: Clock,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(tickMs = 15_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    for (const s of this.schedules) {
      const bucket = nowSeconds - (nowSeconds % s.everySeconds);
      try {
        await this.queue.enqueue(s.spec, s.payload, { uniqueKey: `cron:${s.spec.name}:${bucket}` });
      } catch (err) {
        this.logger.error({ err, job: s.spec.name }, 'failed to enqueue scheduled job');
      }
    }
  }
}
