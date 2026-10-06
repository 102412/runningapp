import { isApiError } from './errors';
import type { ApiClient } from './client';
import type { operations } from './generated/schema';

export type ClientEvent =
  operations['recordEvents']['requestBody']['content']['application/json']['events'][number];
/** An event as you track it: `eventId` is generated for you unless you supply one. */
export type TrackedEvent = Omit<ClientEvent, 'eventId'> & { eventId?: string };

export interface EventBufferOptions {
  /** How often queued events are sent (default 5 s). */
  flushIntervalMs?: number;
  /** Events per request; the server accepts at most 100 (default 50). */
  batchSize?: number;
  /** Beyond this many queued events the OLDEST are dropped (default 2000). */
  maxQueue?: number;
  /** Called when events are discarded (queue overflow or permanently rejected). */
  onDropped?: (events: ClientEvent[], reason: 'overflow' | 'rejected') => void;
  /** Timer functions (tests, React Native...). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  uuid?: () => string;
  now?: () => number;
}

/**
 * Collects behavioural events (impressions, watch time, "not interested"...) and sends them in
 * batches. Designed for flaky mobile networks:
 *  - every event gets a client-generated id, and the server de-duplicates by it, so a batch that
 *    failed halfway can be re-sent as-is without double counting;
 *  - failures keep the events and back off exponentially (honouring Retry-After on 429);
 *  - the queue is bounded; the oldest events are dropped first;
 *  - events the server REJECTS (content the user can no longer see) are never retried.
 *
 * Call `flush()` when the app goes to the background; call `stop()` on sign-out and then discard it.
 */
export class EventBuffer {
  private queue: ClientEvent[] = [];
  private timer: unknown;
  private flushing: Promise<void> | null = null;
  private failures = 0;
  private notBefore = 0;
  private readonly opts: Required<Omit<EventBufferOptions, 'onDropped'>> &
    Pick<EventBufferOptions, 'onDropped'>;

  constructor(
    private readonly client: ApiClient,
    options: EventBufferOptions = {},
  ) {
    this.opts = {
      flushIntervalMs: options.flushIntervalMs ?? 5000,
      batchSize: Math.min(options.batchSize ?? 50, 100),
      maxQueue: options.maxQueue ?? 2000,
      onDropped: options.onDropped,
      setTimer: options.setTimer ?? ((fn, ms) => setInterval(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)),
      uuid: options.uuid ?? (() => crypto.randomUUID()),
      now: options.now ?? Date.now,
    };
  }

  get pending(): number {
    return this.queue.length;
  }

  start(): void {
    if (this.timer === undefined) {
      this.timer = this.opts.setTimer(() => void this.flush(), this.opts.flushIntervalMs);
    }
  }

  stop(): void {
    if (this.timer !== undefined) this.opts.clearTimer(this.timer);
    this.timer = undefined;
  }

  track(event: TrackedEvent): string {
    const eventId = event.eventId ?? this.opts.uuid();
    this.queue.push({ ...event, eventId });
    const overflow = this.queue.length - this.opts.maxQueue;
    if (overflow > 0) this.opts.onDropped?.(this.queue.splice(0, overflow), 'overflow');
    return eventId;
  }

  /** Sends everything queued (in batches). Safe to call at any time; concurrent calls share one run. */
  flush(): Promise<void> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.opts.now() < this.notBefore) return; // backing off
      const batch = this.queue.slice(0, this.opts.batchSize);
      try {
        const result = await this.client.POST('/v1/events', { body: { events: batch } });
        if (result.error !== undefined || !result.data) {
          const status = result.response.status;
          // 4xx other than rate limiting means the batch itself is bad: retrying cannot help.
          if (status >= 400 && status < 500 && status !== 429 && status !== 401) {
            this.queue.splice(0, batch.length);
            this.opts.onDropped?.(batch, 'rejected');
            continue;
          }
          this.backoff(result.response.headers.get('retry-after'));
          return;
        }
        this.queue.splice(0, batch.length);
        this.failures = 0;
        const rejected = new Set(result.data.rejected.map((r) => r.eventId));
        if (rejected.size > 0) {
          this.opts.onDropped?.(
            batch.filter((e) => rejected.has(e.eventId)),
            'rejected',
          );
        }
      } catch (error) {
        if (
          isApiError(error) &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          this.queue.splice(0, batch.length);
          this.opts.onDropped?.(batch, 'rejected');
          continue;
        }
        this.backoff(null);
        return;
      }
    }
  }

  private backoff(retryAfter: string | null): void {
    this.failures += 1;
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    const waitMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
    this.notBefore = this.opts.now() + waitMs;
  }
}
