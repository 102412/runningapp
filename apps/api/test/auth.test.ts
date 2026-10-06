import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, drainJobs, errorCode, latestMail, PASSWORD, signupUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';

describe('auth', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('signup', () => {
    it('creates an account and returns a usable token pair plus the account view', async () => {
      const res = await api(t).post('/auth/signup', {
        email: 'New.Runner@Example.test',
        password: PASSWORD,
        username: 'NewRunner',
        birthDate: '1992-03-04',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.tokens.tokenType).toBe('Bearer');
      expect(body.user.email).toBe('new.runner@example.test'); // normalised
      expect(body.user.profile.username).toBe('NewRunner');
      expect(body.user.emailVerified).toBe(false);
      expect(body.user.isMinor).toBe(false);
      expect(body.user.profile.isPrivate).toBe(false);
      expect(JSON.stringify(body)).not.toContain('passwordHash');

      const me = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${body.tokens.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().id).toBe(body.user.id);
    });

    it('rejects duplicate emails and usernames case-insensitively', async () => {
      const u = await signupUser(t);
      const dupEmail = await api(t).post('/auth/signup', {
        email: u.email.toUpperCase(),
        password: PASSWORD,
        username: 'other_name1',
        birthDate: '1990-01-01',
      });
      expect(dupEmail.statusCode).toBe(409);
      expect(errorCode(dupEmail)).toBe('EMAIL_TAKEN');
      const dupName = await api(t).post('/auth/signup', {
        email: 'fresh@example.test',
        password: PASSWORD,
        username: u.username.toUpperCase(),
        birthDate: '1990-01-01',
      });
      expect(errorCode(dupName)).toBe('USERNAME_TAKEN');
    });

    it('survives concurrent signups racing for the same email (exactly one wins)', async () => {
      const make = (n: number) =>
        api(t).post('/auth/signup', {
          email: 'race@example.test',
          password: PASSWORD,
          username: `racer_${n}`,
          birthDate: '1990-01-01',
        });
      const results = await Promise.all([make(1), make(2), make(3), make(4)]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
    });

    it('rejects weak passwords, bad usernames, impossible dates, and under-age users', async () => {
      const base = { email: 'weak@example.test', username: 'weakling', birthDate: '1990-01-01' };
      expect(
        errorCode(await api(t).post('/auth/signup', { ...base, password: 'password123' })),
      ).toBe('PASSWORD_TOO_WEAK');
      expect(
        errorCode(await api(t).post('/auth/signup', { ...base, password: 'weakling-weakling-1' })),
      ).toBe('PASSWORD_TOO_WEAK');
      expect((await api(t).post('/auth/signup', { ...base, password: 'short' })).statusCode).toBe(
        422,
      );
      expect(
        (await api(t).post('/auth/signup', { ...base, password: PASSWORD, username: '1bad' }))
          .statusCode,
      ).toBe(422);
      expect(
        errorCode(
          await api(t).post('/auth/signup', { ...base, password: PASSWORD, username: 'admin' }),
        ),
      ).toBe('USERNAME_TAKEN'); // reserved
      expect(
        errorCode(
          await api(t).post('/auth/signup', {
            ...base,
            password: PASSWORD,
            birthDate: '2024-02-31',
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      const year = new Date().getUTCFullYear() - 10;
      expect(
        errorCode(
          await api(t).post('/auth/signup', {
            ...base,
            password: PASSWORD,
            birthDate: `${year}-01-01`,
          }),
        ),
      ).toBe('UNDER_MINIMUM_AGE');
    });

    it('rejects unknown fields instead of silently ignoring them (no mass assignment)', async () => {
      const res = await api(t).post('/auth/signup', {
        email: 'mass@example.test',
        password: PASSWORD,
        username: 'massassign',
        birthDate: '1990-01-01',
        role: 'ADMIN',
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('VALIDATION_FAILED');
    });

    it('gives minors private accounts and conservative defaults', async () => {
      const year = new Date().getUTCFullYear() - 15;
      const u = await signupUser(t, { birthDate: `${year}-01-01` });
      const me = (await api(t, u).get('/me')).json();
      expect(me.isMinor).toBe(true);
      expect(me.profile.isPrivate).toBe(true);
      expect(me.settings).toMatchObject({
        accountVisibility: 'PRIVATE',
        defaultPostVisibility: 'FOLLOWERS',
        defaultActivityVisibility: 'PRIVATE',
        defaultCommentPermission: 'FOLLOWERS',
        defaultRoutePrivacy: 'HIDDEN',
      });
      // ...and cannot opt into a public account.
      const res = await api(t, u).patch('/me/settings', { accountVisibility: 'PUBLIC' });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('PUBLIC_ACCOUNT_NOT_ALLOWED');
    });
  });

  describe('login', () => {
    it('returns the same error for a wrong password and an unknown email (no enumeration)', async () => {
      const u = await signupUser(t);
      const wrong = await api(t).post('/auth/login', {
        email: u.email,
        password: 'Wrong-password-123',
      });
      const unknown = await api(t).post('/auth/login', {
        email: 'nobody@example.test',
        password: 'Wrong-password-123',
      });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
      expect(errorCode(unknown)).toBe('INVALID_CREDENTIALS');
      expect(wrong.json().error.message).toBe(unknown.json().error.message);
    });

    it('progressively throttles repeated failures, then recovers on success after the delay', async () => {
      const u = await signupUser(t);
      for (let i = 0; i < 5; i++) {
        expect(
          errorCode(
            await api(t).post('/auth/login', { email: u.email, password: 'Nope-nope-nope-1' }),
          ),
        ).toBe('INVALID_CREDENTIALS');
      }
      const locked = await api(t).post('/auth/login', { email: u.email, password: PASSWORD });
      expect(locked.statusCode).toBe(429);
      expect(errorCode(locked)).toBe('RATE_LIMITED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

      t.clock.advanceSeconds(45);
      const ok = await api(t).post('/auth/login', { email: u.email, password: PASSWORD });
      expect(ok.statusCode).toBe(200);
    });

    it('records a device and lists it with the session', async () => {
      const u = await signupUser(t);
      const sessions = (await api(t, u).get('/auth/sessions')).json();
      expect(sessions.items).toHaveLength(1);
      expect(sessions.items[0]).toMatchObject({
        isCurrent: true,
        device: { name: 'Test phone', platform: 'IOS' },
      });
    });

    it('refuses suspended accounts', async () => {
      const u = await signupUser(t);
      await t.platform.db
        .updateTable('users')
        .set({ status: 'SUSPENDED', suspendedAt: t.clock.now() })
        .where('id', '=', u.id)
        .execute();
      expect(
        errorCode(await api(t).post('/auth/login', { email: u.email, password: PASSWORD })),
      ).toBe('ACCOUNT_SUSPENDED');
      // ...and an existing token stops working at once.
      expect(errorCode(await api(t, u).get('/me/settings'))).toBe('ACCOUNT_SUSPENDED');
      expect((await api(t, u).get('/me')).statusCode).toBe(200); // but they can see why
    });
  });

  describe('tokens', () => {
    it('rejects missing, malformed and tampered tokens', async () => {
      expect(errorCode(await api(t).get('/me'))).toBe('UNAUTHENTICATED');
      const bad = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: 'Bearer not.a.jwt' },
      });
      expect(errorCode(bad)).toBe('TOKEN_INVALID');
      const u = await signupUser(t);
      const tampered = u.accessToken.slice(0, -4) + 'AAAA';
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${tampered}` },
      });
      expect(errorCode(res)).toBe('TOKEN_INVALID');
    });

    it('access tokens expire on schedule (TOKEN_EXPIRED) and refresh restores access', async () => {
      const u = await signupUser(t);
      expect((await api(t, u).get('/me')).statusCode).toBe(200);
      t.clock.advanceSeconds(t.config.ACCESS_TOKEN_TTL_SECONDS + 1);
      const expired = await api(t, u).get('/me');
      expect(expired.statusCode).toBe(401);
      expect(errorCode(expired)).toBe('TOKEN_EXPIRED');

      const refreshed = await api(t).post('/auth/refresh', { refreshToken: u.refreshToken });
      expect(refreshed.statusCode).toBe(200);
      const next = refreshed.json().tokens;
      expect(next.refreshToken).not.toBe(u.refreshToken); // rotated
      const me = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${next.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
    });

    it('refresh tokens expire (REFRESH_TOKEN_INVALID)', async () => {
      const u = await signupUser(t);
      t.clock.advanceSeconds(t.config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 + 60);
      expect(errorCode(await api(t).post('/auth/refresh', { refreshToken: u.refreshToken }))).toBe(
        'REFRESH_TOKEN_INVALID',
      );
    });

    it('detects refresh-token reuse and revokes the whole session', async () => {
      const u = await signupUser(t);
      const first = await api(t).post('/auth/refresh', { refreshToken: u.refreshToken });
      expect(first.statusCode).toBe(200);
      const newer = first.json().tokens;

      // The old token is replayed (e.g. stolen): rejected as reuse...
      const replay = await api(t).post('/auth/refresh', { refreshToken: u.refreshToken });
      expect(replay.statusCode).toBe(401);
      expect(errorCode(replay)).toBe('REFRESH_TOKEN_REUSED');

      // ...and the legitimate newer token is dead too, as is the access token.
      expect(
        errorCode(await api(t).post('/auth/refresh', { refreshToken: newer.refreshToken })),
      ).toBe('SESSION_REVOKED');
      const me = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${newer.accessToken}` },
      });
      expect(errorCode(me)).toBe('SESSION_REVOKED');
    });

    it('concurrent refreshes with one token never mint two valid successors', async () => {
      const u = await signupUser(t);
      const results = await Promise.all(
        [1, 2, 3].map(() => api(t).post('/auth/refresh', { refreshToken: u.refreshToken })),
      );
      expect(results.filter((r) => r.statusCode === 200).length).toBe(1);
    });

    it('logout takes effect immediately for the access token too', async () => {
      const u = await signupUser(t);
      expect((await api(t, u).post('/auth/logout')).statusCode).toBe(204);
      expect(errorCode(await api(t, u).get('/me'))).toBe('SESSION_REVOKED');
      expect(errorCode(await api(t).post('/auth/refresh', { refreshToken: u.refreshToken }))).toBe(
        'SESSION_REVOKED',
      );
    });

    it('logout-all revokes every device; sessions can be revoked individually but never across users', async () => {
      const u = await signupUser(t);
      const other = await signupUser(t);
      const second = await api(t).post('/auth/login', {
        email: u.email,
        password: PASSWORD,
        device: { installId: 'second-device-xx', platform: 'ANDROID' },
      });
      const secondToken = second.json().tokens.accessToken as string;
      const secondSession = second.json().sessionId as string;

      // Cannot revoke someone else's session.
      expect(errorCode(await api(t, other).del(`/auth/sessions/${secondSession}`))).toBe(
        'SESSION_NOT_FOUND',
      );
      // Can revoke own other session.
      expect((await api(t, u).del(`/auth/sessions/${secondSession}`)).statusCode).toBe(204);
      expect(
        errorCode(
          await t.app.inject({
            method: 'GET',
            url: '/v1/me',
            headers: { authorization: `Bearer ${secondToken}` },
          }),
        ),
      ).toBe('SESSION_REVOKED');

      expect((await api(t, u).post('/auth/logout-all')).statusCode).toBe(204);
      expect(errorCode(await api(t, u).get('/me'))).toBe('SESSION_REVOKED');
    });
  });

  describe('email verification', () => {
    it('sends a link, verifies once, and rejects reuse', async () => {
      const u = await signupUser(t, { verified: false });
      expect((await api(t, u).get('/me')).json().emailVerified).toBe(false);
      const mail = await latestMail(t, u.email, 'verify_email');
      expect(mail?.token).toBeTruthy();
      expect(mail?.text).toContain('verify-email?token=');

      expect((await api(t).post('/auth/verify-email', { token: mail?.token })).statusCode).toBe(
        204,
      );
      expect((await api(t, u).get('/me')).json().emailVerified).toBe(true);
      const again = await api(t).post('/auth/verify-email', { token: mail?.token });
      expect(again.statusCode).toBe(410);
      expect(errorCode(again)).toBe('TOKEN_CONSUMED_OR_EXPIRED');
    });

    it('rejects expired tokens and rate-limits resends', async () => {
      const u = await signupUser(t, { verified: false });
      const mail = await latestMail(t, u.email, 'verify_email');
      expect(errorCode(await api(t, u).post('/auth/verify-email/resend'))).toBe('RATE_LIMITED');
      t.clock.advanceSeconds(t.config.EMAIL_VERIFICATION_TTL_HOURS * 3600 + 1);
      expect(errorCode(await api(t).post('/auth/verify-email', { token: mail?.token }))).toBe(
        'TOKEN_CONSUMED_OR_EXPIRED',
      );
    });

    it('never stores a usable raw token in the jobs table', async () => {
      const u = await signupUser(t, { verified: false });
      const jobs = await t.platform.db
        .selectFrom('jobs')
        .select('payload')
        .where('name', '=', 'email.send')
        .execute();
      const mail = await latestMail(t, u.email, 'verify_email');
      expect(mail?.token).toBeTruthy();
      for (const j of jobs)
        expect(JSON.stringify(j.payload)).not.toContain(mail?.token ?? 'impossible');
      const stored = await t.platform.db
        .selectFrom('authTokens')
        .select('tokenHash')
        .where('userId', '=', u.id)
        .execute();
      for (const row of stored) expect(row.tokenHash).not.toBe(mail?.token);
    });
  });

  describe('password reset & change', () => {
    it('forgot-password answers identically for known and unknown emails', async () => {
      const u = await signupUser(t);
      const known = await api(t).post('/auth/password/forgot', { email: u.email });
      const unknown = await api(t).post('/auth/password/forgot', { email: 'ghost@example.test' });
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
      await drainJobs(t);
      expect(await latestMail(t, 'ghost@example.test', 'password_reset')).toBeUndefined();
    });

    it('reset sets the new password, revokes all sessions, and the token is single-use', async () => {
      const u = await signupUser(t);
      await api(t).post('/auth/password/forgot', { email: u.email });
      const mail = await latestMail(t, u.email, 'password_reset');
      const next = 'Brand-New-Passphrase-7';
      expect(
        (await api(t).post('/auth/password/reset', { token: mail?.token, newPassword: next }))
          .statusCode,
      ).toBe(204);
      expect(errorCode(await api(t, u).get('/me'))).toBe('SESSION_REVOKED');
      expect(
        (await api(t).post('/auth/login', { email: u.email, password: PASSWORD })).statusCode,
      ).toBe(401);
      expect(
        (await api(t).post('/auth/login', { email: u.email, password: next })).statusCode,
      ).toBe(200);
      expect(
        (
          await api(t).post('/auth/password/reset', {
            token: mail?.token,
            newPassword: 'Another-Passphrase-8',
          })
        ).statusCode,
      ).toBe(410);
    });

    it('change-password requires the current password and signs out only other sessions', async () => {
      const u = await signupUser(t);
      const second = await api(t).post('/auth/login', { email: u.email, password: PASSWORD });
      const secondHeaders = {
        headers: { authorization: `Bearer ${second.json().tokens.accessToken as string}` },
      };

      expect(
        errorCode(
          await api(t, u).post('/auth/password/change', {
            currentPassword: 'wrong-wrong-1',
            newPassword: 'Fresh-Passphrase-3',
          }),
        ),
      ).toBe('PASSWORD_INCORRECT');
      expect(
        (
          await api(t, u).post('/auth/password/change', {
            currentPassword: PASSWORD,
            newPassword: 'Fresh-Passphrase-3',
          })
        ).statusCode,
      ).toBe(204);
      expect((await api(t, u).get('/me')).statusCode).toBe(200); // this session survives
      expect(errorCode(await api(t, secondHeaders).get('/me'))).toBe('SESSION_REVOKED');
    });
  });

  describe('account deletion workflow', () => {
    it('hides the account, restricts the session, and can be cancelled', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      expect((await api(t, viewer).get(`/users/${u.id}`)).statusCode).toBe(200);

      expect(
        errorCode(await api(t, u).post('/me/account/deletion', { password: 'incorrect-pass-1' })),
      ).toBe('PASSWORD_INCORRECT');
      const del = await api(t, u).post('/me/account/deletion', { password: PASSWORD });
      expect(del.statusCode).toBe(200);
      expect(new Date(del.json().scheduledFor).getTime()).toBeGreaterThan(t.clock.now().getTime());

      // Immediately invisible to others.
      expect(errorCode(await api(t, viewer).get(`/users/${u.id}`))).toBe('USER_NOT_FOUND');
      // Restricted: can read /me and cancel, nothing else.
      const me = (await api(t, u).get('/me')).json();
      expect(me.status).toBe('PENDING_DELETION');
      expect(me.deletion).not.toBeNull();
      expect(errorCode(await api(t, u).get('/me/settings'))).toBe('ACCOUNT_PENDING_DELETION');

      expect((await api(t, u).del('/me/account/deletion')).statusCode).toBe(204);
      expect((await api(t, viewer).get(`/users/${u.id}`)).statusCode).toBe(200);
      expect((await api(t, u).get('/me/settings')).statusCode).toBe(200);
    });
  });
});
