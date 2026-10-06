import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobSpec } from '../src/platform/jobs/queue';
import { JobRegistry, JobWorker } from '../src/platform/jobs/worker';
import { Scheduler } from '../src/platform/jobs/scheduler';
import { createTestApp, type TestApp } from './helpers/app';

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

const TestJob = jobSpec('test.echo', z.object({ n: z.number() }), { maxAttempts: 3 });

describe('job queue', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  function worker(registry: JobRegistry): JobWorker {
    return new JobWorker(t.platform.jobs, registry, { concurrency: 4, logger: t.platform.logger });
  }

  it('runs a job to completion and records success', async () => {
    const seen: number[] = [];
    const registry = new JobRegistry();
    registry.register(TestJob, async ({ n }) => {
      seen.push(n);
    });
    const id = await t.platform.jobs.enqueue(TestJob, { n: 1 });
    expect(await worker(registry).runOnce()).toBeGreaterThanOrEqual(1);
    expect(seen).toContain(1);
    const row = await t.platform.db
      .selectFrom('jobs')
      .select(['status', 'attempts'])
      .where('id', '=', must(id))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
  });

  it('rejects invalid payloads at enqueue time', async () => {
    await expect(
      t.platform.jobs.enqueue(TestJob, { n: 'x' } as unknown as { n: number }),
    ).rejects.toThrow();
  });

  it('dedupes active jobs by dedupeKey but allows re-enqueue after completion', async () => {
    const registry = new JobRegistry();
    registry.register(TestJob, async () => undefined);
    const a = await t.platform.jobs.enqueue(TestJob, { n: 2 }, { dedupeKey: 'k1' });
    const b = await t.platform.jobs.enqueue(TestJob, { n: 2 }, { dedupeKey: 'k1' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await worker(registry).runOnce();
    const c = await t.platform.jobs.enqueue(TestJob, { n: 2 }, { dedupeKey: 'k1' });
    expect(c).not.toBeNull();
  });

  it('retries with backoff then buries the job as DEAD after max attempts', async () => {
    let calls = 0;
    const registry = new JobRegistry();
    registry.register(TestJob, async ({ n }) => {
      // Other tests leave test.echo jobs behind in this database; only count ours.
      if (n === 3) calls++;
      throw new Error('boom');
    });
    const id = await t.platform.jobs.enqueue(TestJob, { n: 3 });
    const w = worker(registry);

    await w.runOnce();
    let row = await t.platform.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', must(id))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toContain('boom');
    expect(row.runAt.getTime()).toBeGreaterThan(t.clock.now().getTime()); // backed off into the future

    // Not due yet: nothing runs.
    expect(await w.runOnce()).toBe(0);

    t.clock.advanceSeconds(3600);
    await w.runOnce();
    t.clock.advanceSeconds(3600);
    await w.runOnce();
    row = await t.platform.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', must(id))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DEAD');
    expect(calls).toBe(3);
  });

  it('never hands the same job to two workers concurrently (SKIP LOCKED)', async () => {
    const executions = new Map<number, number>();
    const registry = new JobRegistry();
    registry.register(TestJob, async ({ n }) => {
      executions.set(n, (executions.get(n) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 15));
    });
    for (let n = 100; n < 140; n++) await t.platform.jobs.enqueue(TestJob, { n });
    await Promise.all([
      worker(registry).runOnce(),
      worker(registry).runOnce(),
      worker(registry).runOnce(),
    ]);
    for (let n = 100; n < 140; n++) expect(executions.get(n)).toBe(1);
  });

  it('re-claims jobs abandoned by a crashed worker after the stale-lock window', async () => {
    const registry = new JobRegistry();
    const ran: number[] = [];
    registry.register(TestJob, async ({ n }) => {
      ran.push(n);
    });
    const id = await t.platform.jobs.enqueue(TestJob, { n: 777 });
    // Simulate a worker that claimed the job and died.
    const claimed = await t.platform.jobs.claim('dead-worker', 1);
    expect(claimed.map((c) => c.id)).toContain(id);
    expect(await worker(registry).runOnce()).toBe(0);
    t.clock.advanceSeconds(16 * 60);
    await worker(registry).runOnce();
    expect(ran).toContain(777);
  });

  it('scheduler enqueues exactly one job per time bucket, however many ticks', async () => {
    const schedules = [{ spec: TestJob, payload: { n: 9 }, everySeconds: 60 }];
    const s1 = new Scheduler(t.platform.jobs, schedules, t.clock, t.platform.logger);
    const s2 = new Scheduler(t.platform.jobs, schedules, t.clock, t.platform.logger);
    const before = await t.platform.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('name', '=', 'test.echo')
      .executeTakeFirstOrThrow();
    await Promise.all([s1.tick(), s2.tick(), s1.tick()]);
    const after = await t.platform.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('name', '=', 'test.echo')
      .executeTakeFirstOrThrow();
    expect(Number(after.c) - Number(before.c)).toBe(1);
  });
});
