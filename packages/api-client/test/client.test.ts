import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  MemoryTokenStore,
  collect,
  createApiClient,
  isApiError,
  paginate,
  unwrap,
} from '../src';
import { apiError, authOf, callAt, json, mockFetch, tokens } from './helpers';

const BASE = 'http://api.test';

function setup(routes: Parameters<typeof mockFetch>[0], initial = tokens(1), extra = {}) {
  const store = new MemoryTokenStore(initial);
  const api = mockFetch(routes);
  const onSessionLost = vi.fn();
  const client = createApiClient({
    baseUrl: BASE,
    tokens: store,
    fetch: api.fetch,
    onSessionLost,
    ...extra,
  });
  return { store, api, client, onSessionLost };
}

const ME = { id: 'u1' };

describe('authentication', () => {
  it('sends the bearer token, but nothing on public endpoints', async () => {
    const { client, api } = setup({
      'GET /v1/me': () => json(200, ME),
      'POST /v1/auth/login': () => json(200, {}),
    });
    await client.GET('/v1/me');
    await client.POST('/v1/auth/login', { body: { email: 'a@b.co', password: 'x' } });
    expect(authOf(callAt(api.calls, 0))).toBe('Bearer access-1');
    expect(authOf(callAt(api.calls, 1))).toBeNull();
  });

  it('refreshes once on TOKEN_EXPIRED and retries the original request (body included)', async () => {
    const { client, api, store } = setup({
      'POST /v1/posts': [
        () => apiError(401, 'TOKEN_EXPIRED'),
        (call) => json(201, { echoed: call.body, auth: authOf(call) }),
      ],
      'POST /v1/auth/refresh': (call) => {
        expect((call.body as { refreshToken: string }).refreshToken).toContain('refresh-1');
        return json(200, { tokens: tokens(2) });
      },
    });
    const res = await client.POST('/v1/posts', { body: { caption: 'hello' } });
    expect(res.response.status).toBe(201);
    expect(res.data).toEqual({ echoed: { caption: 'hello' }, auth: 'Bearer access-2' });
    expect(api.count('POST /v1/auth/refresh')).toBe(1);
    expect(store.get()?.accessToken).toBe('access-2');
  });

  it('shares ONE refresh between concurrent requests (refresh tokens are single use)', async () => {
    const { client, api } = setup({
      'GET /v1/me': [
        ...Array.from({ length: 5 }, () => () => apiError(401, 'TOKEN_EXPIRED')),
        ...Array.from({ length: 5 }, (_, i) => () => json(200, { n: i })),
      ],
      'POST /v1/auth/refresh': async () => {
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { tokens: tokens(2) });
      },
    });
    // The mock hands the first five calls a 401 and later ones a 200.
    const results = await Promise.all(Array.from({ length: 5 }, () => client.GET('/v1/me')));
    expect(results.every((r) => r.response.status === 200)).toBe(true);
    expect(api.count('POST /v1/auth/refresh')).toBe(1);
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const { client, api } = setup(
      {
        'GET /v1/me': (call) => json(200, { auth: authOf(call) }),
        'POST /v1/auth/refresh': () => json(200, { tokens: tokens(2) }),
      },
      tokens(1, 5_000), // expires in 5 s: inside the 30 s leeway
    );
    const res = await client.GET('/v1/me');
    expect(res.data).toEqual({ auth: 'Bearer access-2' });
    expect(api.count('GET /v1/me')).toBe(1); // no failed attempt first
  });

  it('ends the session when the refresh token is refused', async () => {
    const { client, store, onSessionLost, api } = setup({
      'GET /v1/me': () => apiError(401, 'TOKEN_EXPIRED'),
      'POST /v1/auth/refresh': () => apiError(401, 'REFRESH_TOKEN_INVALID'),
    });
    const res = await client.GET('/v1/me');
    expect(res.response.status).toBe(401);
    expect(store.get()).toBeNull();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(onSessionLost).toHaveBeenCalledWith('REFRESH_TOKEN_INVALID');
    // Later calls go out unauthenticated and do not hammer the refresh endpoint.
    await client.GET('/v1/me');
    expect(api.count('POST /v1/auth/refresh')).toBe(1);
  });

  it.each(['SESSION_REVOKED', 'TOKEN_INVALID', 'ACCOUNT_SUSPENDED'])(
    'ends the session on %s without trying to refresh',
    async (code) => {
      const { client, store, onSessionLost, api } = setup({
        'GET /v1/me': () => apiError(code === 'ACCOUNT_SUSPENDED' ? 401 : 401, code),
      });
      await client.GET('/v1/me');
      expect(store.get()).toBeNull();
      expect(onSessionLost).toHaveBeenCalledWith(code);
      expect(api.count('POST /v1/auth/refresh')).toBe(0);
    },
  );

  it('keeps the tokens when the refresh fails for a transient reason', async () => {
    const { client, store, onSessionLost } = setup({
      'GET /v1/me': () => apiError(401, 'TOKEN_EXPIRED'),
      'POST /v1/auth/refresh': () =>
        json(503, { error: { code: 'INTERNAL', message: 'down', requestId: 'r' } }),
    });
    const res = await client.GET('/v1/me');
    expect(res.response.status).toBe(401);
    expect(store.get()?.accessToken).toBe('access-1');
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('uses a cross-tab lock and adopts tokens another tab already refreshed', async () => {
    const store = new MemoryTokenStore(tokens(1));
    const api = mockFetch({
      'GET /v1/me': [
        (call) =>
          authOf(call) === 'Bearer access-1' ? apiError(401, 'TOKEN_EXPIRED') : json(200, ME),
        () => json(200, ME),
      ],
      'POST /v1/auth/refresh': () => json(200, { tokens: tokens(3) }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      tokens: store,
      fetch: api.fetch,
      // Simulates "another tab refreshed while we waited for the lock".
      withRefreshLock: async (fn) => {
        store.set(tokens(2));
        return fn();
      },
    });
    const res = await client.GET('/v1/me');
    expect(res.response.status).toBe(200);
    expect(api.count('POST /v1/auth/refresh')).toBe(0);
  });

  it('exposes a fresh access token on demand', async () => {
    const { client } = setup(
      { 'POST /v1/auth/refresh': () => json(200, { tokens: tokens(2) }) },
      tokens(1, 1000),
    );
    expect(await client.getAccessToken()).toBe('access-2');
    const empty = createApiClient({
      baseUrl: BASE,
      tokens: new MemoryTokenStore(null),
      fetch: mockFetch({}).fetch,
    });
    expect(await empty.getAccessToken()).toBeNull();
  });
});

describe('errors', () => {
  it('turns error responses into ApiError with a stable code and request id', async () => {
    const { client } = setup({
      'POST /v1/posts': () =>
        json(422, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'bad',
            requestId: 'req-9',
            details: [{ path: 'caption', message: 'too long' }],
          },
        }),
    });
    const res = await client.POST('/v1/posts', { body: { caption: 'x' } });
    try {
      unwrap(res);
      expect.unreachable();
    } catch (e) {
      expect(isApiError(e, 'VALIDATION_FAILED')).toBe(true);
      const err = e as ApiError;
      expect([err.status, err.requestId, err.fieldErrors]).toEqual([
        422,
        'req-9',
        { caption: 'too long' },
      ]);
    }
  });

  it('copes with non-JSON error bodies', () => {
    const response = new Response('<html>bad gateway</html>', { status: 502 });
    expect(() => unwrap({ error: '<html>', response })).toThrowError(ApiError);
    try {
      unwrap({ error: '<html>', response });
    } catch (e) {
      expect((e as ApiError).code).toBe('UNKNOWN');
      expect((e as ApiError).status).toBe(502);
    }
  });

  it('returns data on success and undefined for 204', () => {
    expect(unwrap({ data: { ok: 1 }, response: new Response() })).toEqual({ ok: 1 });
    expect(unwrap({ response: new Response(null, { status: 204 }) })).toBeUndefined();
  });
});

describe('pagination', () => {
  it('walks every page, then stops', async () => {
    const pages = [
      { items: [1, 2], nextCursor: 'a' },
      { items: [3], nextCursor: 'b' },
      { items: [], nextCursor: null },
    ];
    const seen: Array<string | undefined> = [];
    const fetchPage = async (cursor: string | undefined) => {
      seen.push(cursor);
      return pages[seen.length - 1] ?? { items: [], nextCursor: null };
    };
    expect(await collect(paginate(fetchPage))).toEqual([1, 2, 3]);
    expect(seen).toEqual([undefined, 'a', 'b']);
  });

  it('respects limits so a bug cannot loop forever', async () => {
    const endless = async () => ({ items: [1], nextCursor: 'again' });
    expect((await collect(paginate(endless, { maxPages: 3 }))).length).toBe(3);
    expect((await collect(paginate(endless), 10)).length).toBe(10);
  });
});
