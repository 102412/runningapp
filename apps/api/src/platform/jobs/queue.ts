import { sql } from 'kysely';
import type { z } from 'zod';
import type { Clock } from '../clock';
import type { Db } from '../db/client';

/** Typed handle for a job: name + payload schema. Defined next to the module that owns it. */
export interface JobSpec<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly schema: S;
  readonly maxAttempts: number;
}

export function jobSpec<S extends z.ZodType>(
  name: string,
  schema: S,
  options: { maxAttempts?: number } = {},
): JobSpec<S> {
  return { name, schema, maxAttempts: options.maxAttempts ?? 5 };
}

/**
 * A RUNNING job whose lock is older than this is considered abandoned (worker crashed) and is
 * re-claimed. Every job must therefore finish well within this window.
 */
const STALE_LOCK_SECONDS = 15 * 60;

export interface EnqueueOptions {
  /** Pass a transaction to enqueue atomically with your state change. */
  db?: Db;
  runAt?: Date;
  /** Skip if a PENDING/RUNNING job with the same key exists. */
  dedupeKey?: string;
  /** Skip if a job with this key EVER existed (cron buckets). */
  uniqueKey?: string;
}

export interface ClaimedJob {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Returns the new job id, or null when deduplicated. Validates the payload. */
  async enqueue<S extends z.ZodType>(
    spec: JobSpec<S>,
    payload: z.input<S>,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const validated: unknown = spec.schema.parse(payload);
    const db = options.db ?? this.db;
    const row = await db
      .insertInto('jobs')
      .values({
        name: spec.name,
        payload: JSON.stringify(validated),
        maxAttempts: spec.maxAttempts,
        runAt: options.runAt ?? this.clock.now(),
        dedupeKey: options.dedupeKey ?? null,
        uniqueKey: options.uniqueKey ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** Atomically claims up to `limit` due jobs (SKIP LOCKED: safe across many workers). */
  async claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_SECONDS * 1000);
    const { rows } = await sql<ClaimedJob>`
      update jobs
         set status = 'RUNNING', locked_at = ${now}, locked_by = ${workerId}, attempts = attempts + 1
       where id in (
         select id from jobs
          where (status = 'PENDING' and run_at <= ${now})
             or (status = 'RUNNING' and locked_at < ${staleBefore})
          order by run_at, id
          for update skip locked
          limit ${limit}
       )
      returning id, name, payload, attempts, max_attempts`.execute(this.db);
    return rows;
  }

  async complete(id: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        status: 'SUCCEEDED',
        finishedAt: this.clock.now(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Re-queues with exponential backoff, or buries the job once attempts are exhausted. */
  async fail(job: ClaimedJob, error: unknown): Promise<'RETRY' | 'DEAD'> {
    const message = (
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    ).slice(0, 2000);
    const now = this.clock.now();
    if (job.attempts >= job.maxAttempts) {
      await this.db
        .updateTable('jobs')
        .set({
          status: 'DEAD',
          finishedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        })
        .where('id', '=', job.id)
        .execute();
      return 'DEAD';
    }
    const backoffSeconds =
      Math.min(3600, 5 * 2 ** (job.attempts - 1)) * (0.75 + Math.random() * 0.5);
    await this.db
      .updateTable('jobs')
      .set({
        status: 'PENDING',
        runAt: new Date(now.getTime() + backoffSeconds * 1000),
        lockedAt: null,
        lockedBy: null,
        lastError: message,
      })
      .where('id', '=', job.id)
      .execute();
    return 'RETRY';
  }

  async purgeFinished(succeededOlderThan: Date, deadOlderThan: Date): Promise<number> {
    const res = await sql`
      delete from jobs
       where (status = 'SUCCEEDED' and finished_at < ${succeededOlderThan})
          or (status = 'DEAD' and finished_at < ${deadOlderThan})`.execute(this.db);
    return Number(res.numAffectedRows ?? 0);
  }
}
