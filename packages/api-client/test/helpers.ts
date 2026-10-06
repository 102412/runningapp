import type { TokenPair } from '../src/client';

export interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

/** A scriptable fetch: routes by "METHOD /path", records every call. */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep raw text */
    }
    const call: Call = {
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      body,
    };
    calls.push(call);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const route = routes[key];
    if (!route)
      return json(404, {
        error: { code: 'NOT_FOUND', message: `no mock for ${key}`, requestId: 'r' },
      });
    const handler = Array.isArray(route)
      ? (route[Math.min(n, route.length) - 1] as Handler)
      : route;
    return handler(call, n);
  };
  return { fetch: fetchImpl, calls, count: (key: string) => counts.get(key) ?? 0 };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const apiError = (status: number, code: string, message = code) =>
  json(status, { error: { code, message, requestId: 'req-1' } });

export function tokens(n: number, expiresInMs = 15 * 60_000, now = Date.now()): TokenPair {
  return {
    tokenType: 'Bearer',
    accessToken: `access-${n}`,
    accessTokenExpiresAt: new Date(now + expiresInMs).toISOString(),
    refreshToken: `refresh-${n}-${'x'.repeat(20)}`,
    refreshTokenExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
  };
}

export const authOf = (call: Call): string | null => call.headers.get('authorization');

/** The i-th recorded call (fails the test loudly if it does not exist). */
export function callAt<T>(calls: readonly T[], index: number): T {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected a call at index ${index}`);
  return call;
}
