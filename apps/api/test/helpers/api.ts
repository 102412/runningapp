import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { registerJobs } from '../../src/jobs';
import { JobWorker } from '../../src/platform/jobs/worker';
import type { TestApp } from './app';

export const PASSWORD = 'Correct-Horse-Battery-9';

export interface TestUser {
  id: string;
  email: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  headers: { authorization: string };
}

let counter = 0;
const unique = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface SignupOptions {
  username?: string;
  email?: string;
  birthDate?: string;
  /** Default true: marks the email verified in the DB so publishing is allowed. */
  verified?: boolean;
  isPrivate?: boolean;
  displayName?: string;
}

/** Creates an account through the real signup endpoint, then adjusts state directly in the DB. */
export async function signupUser(t: TestApp, options: SignupOptions = {}): Promise<TestUser> {
  const tag = unique();
  const username = options.username ?? `user_${tag}`;
  const email = options.email ?? `${username.toLowerCase()}@example.test`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      email,
      password: PASSWORD,
      username,
      displayName: options.displayName ?? `Display ${username}`,
      birthDate: options.birthDate ?? '1990-06-15',
      device: { installId: `install-${tag}-xxxxxxxx`, platform: 'IOS', name: 'Test phone' },
    },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json<{
    user: { id: string };
    tokens: { accessToken: string; refreshToken: string };
    sessionId: string;
  }>();

  if (options.verified !== false) {
    await t.platform.db
      .updateTable('users')
      .set({ emailVerifiedAt: t.clock.now() })
      .where('id', '=', body.user.id)
      .execute();
  }
  if (options.isPrivate !== undefined) {
    await t.platform.db
      .updateTable('profiles')
      .set({ accountVisibility: options.isPrivate ? 'PRIVATE' : 'PUBLIC' })
      .where('userId', '=', body.user.id)
      .execute();
  }
  return {
    id: body.user.id,
    email,
    username,
    password: PASSWORD,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
    sessionId: body.sessionId,
    headers: { authorization: `Bearer ${body.tokens.accessToken}` },
  };
}

/** Signs in again (fresh tokens). Use after advancing the fake clock past the access-token lifetime. */
export async function relogin(t: TestApp, user: TestUser): Promise<TestUser> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: user.email, password: user.password },
  });
  if (res.statusCode !== 200) throw new Error(`relogin failed: ${res.statusCode} ${res.body}`);
  const body = res.json<{
    tokens: { accessToken: string; refreshToken: string };
    sessionId: string;
  }>();
  return {
    ...user,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
    sessionId: body.sessionId,
    headers: { authorization: `Bearer ${body.tokens.accessToken}` },
  };
}

export function api(t: TestApp, user?: Pick<TestUser, 'headers'> | null) {
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      headers: user ? user.headers : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}

/** Runs every currently-due background job (emails, media processing, ...). */
export async function drainJobs(t: TestApp): Promise<number> {
  const { registry } = registerJobs(t.services);
  const worker = new JobWorker(t.platform.jobs, registry, {
    concurrency: 4,
    logger: t.platform.logger,
  });
  return worker.runOnce();
}

export function errorCode(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code;
}

export async function latestMail(
  t: TestApp,
  to: string,
  template: string,
): Promise<{ token: string | null; text: string } | undefined> {
  await drainJobs(t);
  const row = await t.platform.db
    .selectFrom('devMailOutbox')
    .select(['token', 'textBody'])
    .where('toEmail', '=', to.toLowerCase())
    .where('template', '=', template)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return row ? { token: row.token, text: row.textBody } : undefined;
}

export type { FastifyInstance };
