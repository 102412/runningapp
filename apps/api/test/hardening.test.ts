import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { buildLoggerOptions } from '../src/platform/logging';
import { api, errorCode, signupUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';

const SAFE_PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/app',
  JWT_SECRET: 'prod-jwt-secret-that-is-long-enough-1234567890',
  MEDIA_SIGNING_SECRET: 'prod-media-secret-that-is-long-enough-123456',
  MAIL_DRIVER: 'smtp',
  SMTP_URL: 'smtp://mail.internal:587',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE000000000',
  S3_SECRET_ACCESS_KEY: 'example-secret-key-value',
  CORS_ORIGINS: 'https://app.example.com',
};

describe('production configuration guards', () => {
  it('accepts a complete, safe production configuration', () => {
    const config = loadConfig(SAFE_PROD);
    expect(config.isProduction).toBe(true);
    expect(config.DEV_ENDPOINTS_ENABLED).toBe(false);
    expect(config.DEV_AUTO_VERIFY_EMAIL).toBe(false);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
  });

  it('refuses development defaults, listing every problem at once', () => {
    let message = '';
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    for (const problem of ['JWT_SECRET', 'MEDIA_SIGNING_SECRET', 'MAIL_DRIVER', 'STORAGE_DRIVER']) {
      expect(message, problem).toContain(problem);
    }
  });

  it.each([
    ['DEV_ENDPOINTS_ENABLED', 'true', /DEV_ENDPOINTS_ENABLED/],
    ['DEV_AUTO_VERIFY_EMAIL', 'true', /DEV_AUTO_VERIFY_EMAIL/],
    ['RATE_LIMIT_ENABLED', 'false', /RATE_LIMIT_ENABLED/],
    ['CORS_ORIGINS', '*', /CORS_ORIGINS/],
    ['STORAGE_DRIVER', 'local', /STORAGE_DRIVER/],
    ['MAIL_DRIVER', 'console', /MAIL_DRIVER/],
  ])('refuses %s=%s in production', (name, value, pattern) => {
    expect(() => loadConfig({ ...SAFE_PROD, [name]: value })).toThrow(pattern);
  });

  it('refuses short secrets, and an s3 driver without credentials', () => {
    expect(() => loadConfig({ ...SAFE_PROD, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
    const { S3_SECRET_ACCESS_KEY: _omit, ...withoutKey } = SAFE_PROD;
    expect(() => loadConfig(withoutKey)).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  it('refuses the placeholder secrets that ship in .env.example', () => {
    const placeholder = 'change-me-change-me-change-me-change-me-change-me';
    expect(() => loadConfig({ ...SAFE_PROD, JWT_SECRET: placeholder })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...SAFE_PROD, MEDIA_SIGNING_SECRET: placeholder })).toThrow(
      /MEDIA_SIGNING_SECRET/,
    );
  });

  it('documents every environment variable in .env.example (and invents none)', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/config.ts'), 'utf8');
    const schemaBlock = source.slice(
      source.indexOf('z.object({'),
      source.indexOf('export type Config'),
    );
    const declared = [...schemaBlock.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)]
      .map((m) => m[1] as string)
      .sort();
    const example = readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
    const documented = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
      (m) => m[1] as string,
    );
    expect(
      declared.filter((k) => !documented.includes(k)),
      'missing from .env.example',
    ).toEqual([]);
    expect(
      documented.filter((k) => !declared.includes(k)),
      'in .env.example but not in config',
    ).toEqual([]);
  });

  it('keeps developer conveniences on outside production only', () => {
    const dev = loadConfig({ NODE_ENV: 'development' });
    expect([dev.DEV_ENDPOINTS_ENABLED, dev.DEV_AUTO_VERIFY_EMAIL]).toEqual([true, true]);
  });
});

describe('log redaction', () => {
  it('censors credentials even if code logs them by mistake', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(
      buildLoggerOptions(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' })),
      sink,
    );
    logger.info(
      {
        password: 'hunter2-password',
        body: { newPassword: 'n3w-secret-pass', refreshToken: 'refresh-secret-value' },
        user: { passwordHash: '$argon2id$secret', accessToken: 'jwt-secret-value' },
        req: { headers: { authorization: 'Bearer top-secret-jwt', cookie: 'sid=abc' } },
      },
      'sensitive',
    );
    const out = lines.join('');
    for (const secret of [
      'hunter2-password',
      'n3w-secret-pass',
      'refresh-secret-value',
      '$argon2id$secret',
      'jwt-secret-value',
      'top-secret-jwt',
      'sid=abc',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('drops the query string (signed media URLs) from request logs', () => {
    const options = buildLoggerOptions(loadConfig({ NODE_ENV: 'test' }));
    const req = options.serializers?.req as (r: unknown) => { url: string };
    expect(
      req({
        method: 'GET',
        url: '/v1/storage/files/a.jpg?exp=1&sig=SECRET',
        id: 'x',
        ip: '1.2.3.4',
      }).url,
    ).toBe('/v1/storage/files/a.jpg');
  });
});

describe('HTTP hardening', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    vi.restoreAllMocks();
  });

  it('hides internals on unexpected failures and still correlates by request id', async () => {
    t = await createTestApp();
    vi.spyOn(t.services.sports, 'list').mockRejectedValue(
      new Error('boom: password=hunter2 at /srv/secret.ts:42'),
    );
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/sports',
      headers: { 'x-request-id': 'trace-me-12345' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.requestId).toBe('trace-me-12345');
    expect(res.headers['x-request-id']).toBe('trace-me-12345');
    expect(res.body).not.toMatch(/boom|hunter2|secret\.ts|stack|at /);
  });

  it('replaces hostile request ids instead of echoing them (log/header injection)', async () => {
    t = await createTestApp();
    for (const hostile of [
      'short',
      'has spaces in it',
      'x'.repeat(200),
      'a<script>alert(1)</script>',
    ]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': hostile },
      });
      expect(res.headers['x-request-id'], hostile.slice(0, 20)).not.toBe(hostile);
      expect(String(res.headers['x-request-id'])).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    }
  });

  it('sends security headers, no framework banner, and never caches API responses', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/v1/sports' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toBeDefined();
    const authed = await signupUser(t);
    const me = await api(t, authed).get('/me');
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('only allows configured CORS origins in production-style setups', async () => {
    t = await createTestApp({ env: { CORS_ORIGINS: 'https://app.example.com' } });
    const allowed = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects oversized and malformed JSON bodies with the standard envelope', async () => {
    t = await createTestApp();
    const big = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect([big.statusCode, errorCode(big)]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    const broken = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect([broken.statusCode, errorCode(broken)]).toEqual([400, 'MALFORMED_JSON']);
    // Plain text parses as a string, which then fails the object schema; XML has no parser at all.
    const text = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect([text.statusCode, errorCode(text)]).toEqual([422, 'VALIDATION_FAILED']);
    const xml = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect([xml.statusCode, errorCode(xml)]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    const unknown = await t.app.inject({ method: 'GET', url: '/v1/definitely/not/a/route' });
    expect([unknown.statusCode, errorCode(unknown)]).toEqual([404, 'NOT_FOUND']);
  });

  it('rate limits credential endpoints per IP (and tells the client when to retry)', async () => {
    t = await createTestApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
    const app = t.app;
    // Different emails each time, so only the per-IP limiter (10/min on credential routes) can trip.
    const attempt = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: `nobody${i}@example.test`, password: 'wrong-password-1' },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await attempt(i)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    const limited = await attempt(99);
    expect([limited.statusCode, errorCode(limited)]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Health checks are exempt so orchestrators never get throttled.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('also throttles guessing at ONE account, whatever IP the guesses come from', async () => {
    t = await createTestApp();
    const app = t.app;
    const victim = await signupUser(t);
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: victim.email, password: 'wrong-password-1' },
        remoteAddress: `10.0.0.${Math.floor(Math.random() * 200)}`,
      });
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) codes.push(errorCode(await attempt()));
    expect(codes.slice(0, 5)).toEqual(Array(5).fill('INVALID_CREDENTIALS'));
    expect(codes.slice(5).every((c) => c === 'RATE_LIMITED')).toBe(true);
    // Even the right password is refused while locked out (no oracle for the attacker).
    const right = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: victim.email, password: victim.password },
    });
    expect(right.statusCode).toBe(429);
  });

  it('keeps /metrics closed in production-like mode unless a token is configured', async () => {
    t = await createTestApp({ env: { METRICS_TOKEN: 'metrics-token-1234567890' } });
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer wrong-token-0000000000' },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token-1234567890' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('http_request_duration_seconds');
  });
});
