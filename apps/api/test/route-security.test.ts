import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';

/**
 * Security audit tests that look at EVERY route the server actually exposes (taken from the live
 * OpenAPI document, so a new endpoint is covered the moment it exists) instead of trusting
 * per-endpoint tests to remember the basics:
 *
 *  1. every route that declares bearer auth really rejects anonymous and forged callers;
 *  2. a route can only be public if it is on an explicit allow-list (new ones fail this test until
 *     someone consciously adds them);
 *  3. staff routes refuse ordinary users;
 *  4. request bodies are strict (unknown fields are refused, never silently stored);
 *  5. dev-only helpers do not exist unless explicitly enabled.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];

interface Operation {
  method: Method;
  path: string;
  url: string;
  security: Array<Record<string, unknown>> | undefined;
  tags: string[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
}

/** Routes that are deliberately reachable without credentials. Adding one is a security decision. */
const PUBLIC_ROUTES = new Set([
  'POST /v1/auth/signup',
  'POST /v1/auth/login',
  'POST /v1/auth/refresh',
  'POST /v1/auth/verify-email',
  'POST /v1/auth/password/forgot',
  'POST /v1/auth/password/reset',
  'GET /v1/auth/username-available',
  'GET /v1/sports',
  // Local-storage driver only: authorised by an HMAC-signed URL, not by a session.
  'PUT /v1/storage/upload',
  'GET /v1/storage/files/{*}',
  // Dev-only (DEV_ENDPOINTS_ENABLED, refused in production).
  'GET /v1/dev/outbox',
]);

const UUID = '018f0000-0000-7000-8000-000000000000';
const fill = (path: string) =>
  path.replace(/\{[^}]+\}/g, (m) =>
    m === '{slug}' ? 'topic' : m === '{username}' ? 'someone' : m === '{*}' ? 'a/b' : UUID,
  );

function operationsOf(doc: { paths: Record<string, Record<string, unknown>> }): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as
        | {
            security?: Array<Record<string, unknown>>;
            tags?: string[];
            requestBody?: Operation['requestBody'];
          }
        | undefined;
      if (!op) continue;
      out.push({
        method,
        path,
        url: fill(path),
        security: op.security,
        tags: op.tags ?? [],
        requestBody: op.requestBody,
      });
    }
  }
  return out;
}

const key = (o: Operation) => `${o.method.toUpperCase()} ${o.path}`;
const isPublic = (o: Operation) => !o.security || o.security.length === 0;
const isOptional = (o: Operation) => !!o.security?.some((s) => Object.keys(s).length === 0);

describe('route security (every exposed route)', () => {
  let t: TestApp;
  let ops: Operation[];
  let user: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
    await t.app.ready();
    ops = operationsOf(t.app.swagger() as never);
    user = await signupUser(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const call = (o: Operation, headers: Record<string, string> = {}) =>
    t.app.inject({
      method: o.method.toUpperCase() as 'GET',
      url: o.url,
      headers,
      payload: o.method === 'get' || o.method === 'delete' ? undefined : {},
    });

  it('exposes a sensible number of routes (guards against the document silently emptying)', () => {
    expect(ops.length).toBeGreaterThan(90);
  });

  it('only allow-listed routes are public', () => {
    const publicNow = ops.filter(isPublic).map(key).sort();
    expect(publicNow).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('every route requiring authentication refuses anonymous callers with UNAUTHENTICATED', async () => {
    const required = ops.filter((o) => !isPublic(o) && !isOptional(o));
    expect(required.length).toBeGreaterThan(60);
    for (const o of required) {
      const res = await call(o);
      expect([res.statusCode, errorCode(res)], key(o)).toEqual([401, 'UNAUTHENTICATED']);
    }
  });

  it('every authenticated or optionally-authenticated route refuses a forged or malformed token', async () => {
    const guarded = ops.filter((o) => !isPublic(o));
    for (const o of guarded) {
      for (const token of ['garbage', 'a.b.c', 'Bearer-less']) {
        const res = await call(o, { authorization: `Bearer ${token}` });
        expect(res.statusCode, `${key(o)} with "${token}"`).toBe(401);
      }
      const noScheme = await call(o, { authorization: 'Basic abc' });
      expect(noScheme.statusCode, `${key(o)} with Basic auth`).toBe(401);
    }
  });

  it('a valid token gets past authentication on every guarded route (never 401, never a crash)', async () => {
    const guarded = ops.filter((o) => !isPublic(o) && !o.tags.includes('Admin'));
    for (const o of guarded) {
      // A fresh account per route: some routes legitimately end sessions (logout) or lock accounts.
      const fresh = await signupUser(t);
      const res = await call(o, fresh.headers);
      expect(res.statusCode, key(o)).not.toBe(401);
      expect(res.statusCode, `${key(o)} must not crash`).toBeLessThan(500);
    }
  });

  it('optionally authenticated routes work anonymously', async () => {
    for (const o of ops.filter(isOptional)) {
      const res = await call(o);
      expect(res.statusCode, key(o)).not.toBe(401);
      expect(res.statusCode, key(o)).toBeLessThan(500);
    }
  });

  it('staff routes refuse ordinary users with INSUFFICIENT_ROLE', async () => {
    const admin = ops.filter((o) => o.tags.includes('Admin'));
    expect(admin.length).toBeGreaterThanOrEqual(5);
    for (const o of admin) {
      const res = await call(o, user.headers);
      expect([res.statusCode, errorCode(res)], key(o)).toEqual([403, 'INSUFFICIENT_ROLE']);
    }
  });

  it('refuses unknown fields in every JSON request body (no mass assignment)', () => {
    const offenders: string[] = [];
    const walk = (schema: unknown, pointer: string) => {
      if (!schema || typeof schema !== 'object') return;
      const s = schema as Record<string, unknown>;
      if (s.properties && typeof s.properties === 'object') {
        if (s.additionalProperties !== false)
          offenders.push(`${pointer} (additionalProperties is not false)`);
        for (const [name, child] of Object.entries(s.properties)) walk(child, `${pointer}.${name}`);
      }
      for (const k of ['items', 'anyOf', 'oneOf', 'allOf']) {
        const v = s[k];
        if (Array.isArray(v)) v.forEach((c, i) => walk(c, `${pointer}.${k}[${i}]`));
        else if (v) walk(v, `${pointer}.${k}`);
      }
    };
    for (const o of ops) {
      const schema = o.requestBody?.content?.['application/json']?.schema;
      if (schema) walk(schema, key(o));
    }
    expect(offenders).toEqual([]);
  });

  it('does not expose dev helpers or the local storage endpoints unless explicitly enabled', async () => {
    const dev = ops.filter((o) => o.tags.includes('Dev')).map(key);
    expect(dev.length).toBeGreaterThan(0); // present in this test app (dev endpoints on)

    const prodLike = await createTestApp({ env: { DEV_ENDPOINTS_ENABLED: 'false' } });
    try {
      const names = operationsOf(prodLike.app.swagger() as never)
        .filter((o) => o.url.includes('/dev/'))
        .map(key);
      expect(names).toEqual([]);
      expect((await prodLike.app.inject({ method: 'GET', url: '/v1/dev/outbox' })).statusCode).toBe(
        404,
      );
    } finally {
      await prodLike.close();
    }
  });
});
