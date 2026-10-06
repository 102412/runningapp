import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { Metrics } from '../metrics/metrics';
import type { ClaimedJob, JobQueue, JobSpec } from './queue';

export type JobHandler<S extends z.ZodType> = (payload: z.output<S>) => Promise<void>;

interface Registered {
  spec: JobSpec;
  handler: (payload: unknown) => Promise<void>;
}

/** Name -> handler map. Modules register their jobs here at composition time. */
export class JobRegistry {
  private readonly handlers = new Map<string, Registered>();

  register<S extends z.ZodType>(spec: JobSpec<S>, handler: JobHandler<S>): void {
    if (this.handlers.has(spec.name)) throw new Error(`Job ${spec.name} registered twice`);
    this.handlers.set(spec.name, {
      spec,
      handler: (payload) => handler(spec.schema.parse(payload)),
    });
  }

  get(name: string): Registered | undefined {
    return this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs?: number;
  logger: FastifyBaseLogger;
  metrics?: Metrics;
}

export class JobWorker {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queue: JobQueue,
    private readonly registry: JobRegistry,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  /** Processes every currently-due job and returns how many ran. Used by tests and `drain`. */
  async runOnce(): Promise<number> {
    let total = 0;
    for (;;) {
      const jobs = await this.queue.claim(this.workerId, this.options.concurrency);
      if (jobs.length === 0) return total;
      await Promise.all(jobs.map((j) => this.process(j)));
      total += jobs.length;
    }
  }

  private async loop(): Promise<void> {
    const pollMs = this.options.pollIntervalMs ?? 1000;
    while (this.running) {
      let claimed = 0;
      try {
        const free = this.options.concurrency - this.inFlight.size;
        if (free > 0) {
          const jobs = await this.queue.claim(this.workerId, free);
          claimed = jobs.length;
          for (const job of jobs) {
            const p = this.process(job).finally(() => this.inFlight.delete(p));
            this.inFlight.add(p);
          }
        }
      } catch (err) {
        this.options.logger.error({ err }, 'job claim failed');
      }
      if (!this.running) break;
      // Poll again immediately while there is work; otherwise back off.
      const delay = claimed > 0 ? 0 : pollMs;
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, delay);
      });
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    const log = this.options.logger.child({ jobId: job.id, job: job.name, attempt: job.attempts });
    const registered = this.registry.get(job.name);
    try {
      if (!registered) throw new Error(`No handler registered for job "${job.name}"`);
      if (job.attempts > job.maxAttempts)
        throw new Error('Exceeded max attempts (worker crashed mid-run)');
      await registered.handler(job.payload);
      await this.queue.complete(job.id);
      this.options.metrics?.jobsProcessed.inc({ name: job.name, outcome: 'success' });
      log.debug('job succeeded');
    } catch (err) {
      const outcome = await this.queue.fail(job, err);
      this.options.metrics?.jobsProcessed.inc({
        name: job.name,
        outcome: outcome === 'DEAD' ? 'dead' : 'retry',
      });
      log.warn({ err, outcome }, 'job failed');
    }
  }
}
