import type { Pool } from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics on a private registry (no global state, safe in tests).
 * Labels are deliberately low-cardinality: route *patterns*, never raw URLs or user IDs.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  readonly jobsProcessed: Counter<'name' | 'outcome'>;
  readonly authEvents: Counter<'event'>;
  readonly jobQueueDepth: Gauge<'status'>;

  constructor(pool?: Pool) {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by route pattern',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.jobsProcessed = new Counter({
      name: 'jobs_processed_total',
      help: 'Background jobs processed',
      labelNames: ['name', 'outcome'],
      registers: [this.registry],
    });
    this.authEvents = new Counter({
      name: 'auth_events_total',
      help: 'Authentication events',
      labelNames: ['event'],
      registers: [this.registry],
    });
    this.jobQueueDepth = new Gauge({
      name: 'job_queue_depth',
      help: 'Jobs by status (sampled on scrape)',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        if (!pool) return;
        const { rows } = await pool.query<{ status: string; n: string }>(
          `select status, count(*) as n from jobs where status in ('PENDING','RUNNING','DEAD') group by status`,
        );
        this.reset();
        for (const status of ['PENDING', 'RUNNING', 'DEAD']) {
          this.set({ status }, Number(rows.find((r) => r.status === status)?.n ?? 0));
        }
      },
    });
    if (pool) {
      new Gauge({
        name: 'db_pool_connections',
        help: 'pg pool connections by state',
        labelNames: ['state'],
        registers: [this.registry],
        collect() {
          this.set({ state: 'total' }, pool.totalCount);
          this.set({ state: 'idle' }, pool.idleCount);
          this.set({ state: 'waiting' }, pool.waitingCount);
        },
      });
    }
  }
}
