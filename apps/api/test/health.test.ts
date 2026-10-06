import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

describe('system endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET /healthz reports liveness', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /readyz verifies database and migrations', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const given = await t.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'client-req-12345' },
    });
    expect(given.headers['x-request-id']).toBe('client-req-12345');
    const bad = await t.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'bad id with spaces!' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown routes use the standard error envelope with the request id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('sets security headers and disables caching of API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves a valid OpenAPI 3.1 document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const doc = res.json<{ openapi: string; info: { title: string } }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('RunningApp API');
  });
});
