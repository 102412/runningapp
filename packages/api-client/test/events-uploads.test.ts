import { describe, expect, it, vi } from 'vitest';
import { EventBuffer, MemoryTokenStore, createApiClient, isApiError, uploadMedia } from '../src';
import { apiError, callAt, json, mockFetch, tokens } from './helpers';

const BASE = 'http://api.test';
const clientFor = (routes: Parameters<typeof mockFetch>[0]) => {
  const api = mockFetch(routes);
  return {
    api,
    client: createApiClient({
      baseUrl: BASE,
      tokens: new MemoryTokenStore(tokens(1)),
      fetch: api.fetch,
    }),
  };
};

describe('EventBuffer', () => {
  it('batches, assigns ids and clears the queue on success', async () => {
    const { client, api } = clientFor({
      'POST /v1/events': (call) =>
        json(200, {
          accepted: (call.body as { events: unknown[] }).events.length,
          duplicates: 0,
          rejected: [],
        }),
    });
    const buffer = new EventBuffer(client, {
      batchSize: 2,
      uuid: (() => {
        let i = 0;
        return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`;
      })(),
    });
    for (let i = 0; i < 5; i++)
      buffer.track({ type: 'IMPRESSION', postId: '018f0000-0000-7000-8000-000000000001' });
    expect(buffer.pending).toBe(5);
    await buffer.flush();
    expect(buffer.pending).toBe(0);
    expect(api.count('POST /v1/events')).toBe(3); // 2 + 2 + 1
    const ids = api.calls.flatMap((c) =>
      (c.body as { events: Array<{ eventId: string }> }).events.map((e) => e.eventId),
    );
    expect(new Set(ids).size).toBe(5);
  });

  it('keeps events through failures and re-sends them with the SAME ids', async () => {
    const attempts: string[][] = [];
    let now = 0;
    const { client } = clientFor({
      'POST /v1/events': [
        (call) => {
          attempts.push(
            (call.body as { events: Array<{ eventId: string }> }).events.map((e) => e.eventId),
          );
          return apiError(503, 'INTERNAL');
        },
        (call) => {
          attempts.push(
            (call.body as { events: Array<{ eventId: string }> }).events.map((e) => e.eventId),
          );
          return json(200, { accepted: 2, duplicates: 0, rejected: [] });
        },
      ],
    });
    const buffer = new EventBuffer(client, { now: () => now });
    buffer.track({ type: 'IMPRESSION', postId: '018f0000-0000-7000-8000-000000000001' });
    buffer.track({ type: 'SKIP', postId: '018f0000-0000-7000-8000-000000000001' });
    await buffer.flush();
    expect(buffer.pending).toBe(2); // kept
    await buffer.flush(); // still backing off: nothing sent
    expect(attempts).toHaveLength(1);
    now += 5_000; // past the backoff
    await buffer.flush();
    expect(buffer.pending).toBe(0);
    expect(attempts[1]).toEqual(attempts[0]); // idempotent retry
  });

  it('honours Retry-After on 429', async () => {
    let now = 0;
    const { client, api } = clientFor({
      'POST /v1/events': [
        () =>
          json(
            429,
            { error: { code: 'RATE_LIMITED', message: 'slow', requestId: 'r' } },
            { 'retry-after': '30' },
          ),
        () => json(200, { accepted: 1, duplicates: 0, rejected: [] }),
      ],
    });
    const buffer = new EventBuffer(client, { now: () => now });
    buffer.track({ type: 'IMPRESSION', postId: '018f0000-0000-7000-8000-000000000001' });
    await buffer.flush();
    now += 10_000;
    await buffer.flush();
    expect(api.count('POST /v1/events')).toBe(1);
    now += 25_000;
    await buffer.flush();
    expect(buffer.pending).toBe(0);
  });

  it('drops permanently rejected events instead of retrying them forever', async () => {
    const dropped = vi.fn();
    const { client } = clientFor({
      'POST /v1/events': (call) => {
        const events = (call.body as { events: Array<{ eventId: string }> }).events;
        return json(200, {
          accepted: events.length - 1,
          duplicates: 0,
          rejected: [{ eventId: callAt(events, 0).eventId, code: 'POST_NOT_FOUND' }],
        });
      },
    });
    const buffer = new EventBuffer(client, { onDropped: dropped });
    const rejectedId = buffer.track({
      type: 'IMPRESSION',
      postId: '018f0000-0000-7000-8000-000000000001',
    });
    buffer.track({ type: 'IMPRESSION', postId: '018f0000-0000-7000-8000-000000000002' });
    await buffer.flush();
    expect(buffer.pending).toBe(0);
    expect(dropped).toHaveBeenCalledWith(
      [expect.objectContaining({ eventId: rejectedId })],
      'rejected',
    );

    // A malformed batch (422) is dropped too.
    const bad = clientFor({ 'POST /v1/events': () => apiError(422, 'VALIDATION_FAILED') });
    const b2 = new EventBuffer(bad.client, { onDropped: dropped });
    b2.track({ type: 'IMPRESSION', postId: 'x' } as never);
    await b2.flush();
    expect(b2.pending).toBe(0);
  });

  it('bounds the queue by dropping the oldest events', () => {
    const dropped = vi.fn();
    const { client } = clientFor({});
    const buffer = new EventBuffer(client, { maxQueue: 3, onDropped: dropped });
    for (let i = 0; i < 5; i++) buffer.track({ type: 'SKIP', postId: String(i) } as never);
    expect(buffer.pending).toBe(3);
    expect(dropped).toHaveBeenCalledTimes(2);
  });

  it('flushes on a timer once started, and stops cleanly', async () => {
    const { client, api } = clientFor({
      'POST /v1/events': () => json(200, { accepted: 1, duplicates: 0, rejected: [] }),
    });
    let tick: (() => void) | undefined;
    const buffer = new EventBuffer(client, {
      setTimer: (fn) => {
        tick = fn;
        return 1;
      },
      clearTimer: () => {
        tick = undefined;
      },
    });
    buffer.start();
    buffer.track({ type: 'IMPRESSION', postId: '018f0000-0000-7000-8000-000000000001' });
    tick?.();
    await buffer.flush();
    expect(api.count('POST /v1/events')).toBe(1);
    buffer.stop();
    expect(tick).toBeUndefined();
  });
});

describe('uploadMedia', () => {
  const mediaStub = (status: string, extra: object = {}) => ({
    id: '018f0000-0000-7000-8000-0000000000aa',
    kind: 'VIDEO',
    purpose: 'POST',
    status,
    failureCode: null,
    ...extra,
  });

  it('reserves, PUTs without auth, completes and waits until READY', async () => {
    const put = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('video/mp4');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response(null, { status: 200 });
    });
    const { client, api } = clientFor({
      'POST /v1/media/uploads': (call) => {
        expect(call.body).toMatchObject({
          kind: 'VIDEO',
          mimeType: 'video/mp4',
          sizeBytes: 4,
          purpose: 'POST',
        });
        return json(201, {
          media: mediaStub('PENDING_UPLOAD'),
          upload: {
            method: 'PUT',
            url: 'http://storage.test/up?sig=1',
            headers: { 'Content-Type': 'video/mp4' },
            expiresAt: new Date().toISOString(),
          },
        });
      },
      'POST /v1/media/018f0000-0000-7000-8000-0000000000aa/complete': () =>
        json(200, mediaStub('PROCESSING')),
      'GET /v1/media/018f0000-0000-7000-8000-0000000000aa': [
        () => json(200, mediaStub('PROCESSING')),
        () => json(200, mediaStub('READY')),
      ],
    });
    const statuses: string[] = [];
    const media = await uploadMedia(client, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      data: new Uint8Array([1, 2, 3, 4]),
      fetch: put,
      sleep: async () => undefined,
      onStatus: (m) => statuses.push(m.status),
    });
    expect(media.status).toBe('READY');
    expect(statuses).toEqual(['PROCESSING', 'PROCESSING', 'READY']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(api.count('POST /v1/media/uploads')).toBe(1);
  });

  it('throws MEDIA_REJECTED when processing refuses the file, and reports a failed PUT', async () => {
    const init = () =>
      json(201, {
        media: mediaStub('PENDING_UPLOAD'),
        upload: {
          method: 'PUT',
          url: 'http://storage.test/up',
          headers: {},
          expiresAt: new Date().toISOString(),
        },
      });
    const rejected = clientFor({
      'POST /v1/media/uploads': init,
      'POST /v1/media/018f0000-0000-7000-8000-0000000000aa/complete': () =>
        json(200, mediaStub('REJECTED', { failureCode: 'UNSUPPORTED_CODEC' })),
    });
    await expect(
      uploadMedia(rejected.client, {
        kind: 'VIDEO',
        mimeType: 'video/mp4',
        data: new Uint8Array(1),
        fetch: async () => new Response(null, { status: 200 }),
        sleep: async () => undefined,
      }),
    ).rejects.toSatisfy((e: unknown) => isApiError(e, 'MEDIA_REJECTED'));

    const failedPut = clientFor({ 'POST /v1/media/uploads': init });
    await expect(
      uploadMedia(failedPut.client, {
        kind: 'VIDEO',
        mimeType: 'video/mp4',
        data: new Uint8Array(1),
        fetch: async () => new Response('denied', { status: 403 }),
      }),
    ).rejects.toThrow(/HTTP 403/);
    expect(
      failedPut.api.count('POST /v1/media/018f0000-0000-7000-8000-0000000000aa/complete'),
    ).toBe(0);
  });

  it('gives up with MEDIA_NOT_READY when processing takes too long', async () => {
    const { client } = clientFor({
      'POST /v1/media/uploads': () =>
        json(201, {
          media: mediaStub('PENDING_UPLOAD'),
          upload: {
            method: 'PUT',
            url: 'http://storage.test/up',
            headers: {},
            expiresAt: new Date().toISOString(),
          },
        }),
      'POST /v1/media/018f0000-0000-7000-8000-0000000000aa/complete': () =>
        json(200, mediaStub('PROCESSING')),
      'GET /v1/media/018f0000-0000-7000-8000-0000000000aa': () =>
        json(200, mediaStub('PROCESSING')),
    });
    await expect(
      uploadMedia(client, {
        kind: 'VIDEO',
        mimeType: 'video/mp4',
        data: new Uint8Array(1),
        timeoutMs: -1,
        fetch: async () => new Response(null, { status: 200 }),
        sleep: async () => undefined,
      }),
    ).rejects.toSatisfy((e: unknown) => isApiError(e, 'MEDIA_NOT_READY'));
  });
});
