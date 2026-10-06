import { sql, type Transaction } from 'kysely';
import type {
  DeviceInfo,
  LoginRequest,
  SessionView,
  SignupRequest,
  TokenPair,
} from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import { generateToken, hashToken } from '../../platform/crypto/tokens';
import {
  hashPassword,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from '../../platform/crypto/password';
import type { Db } from '../../platform/db/client';
import type { DB } from '../../platform/db/generated';
import { AppError } from '../../platform/errors';
import { ipPrefix } from '../../platform/http/ip';
import type { MailService } from '../../platform/mail/service';
import type { Metrics } from '../../platform/metrics/metrics';
import { ageOn, isRealDate } from '../users/age';
import type { UserRepository, UserRecord } from '../users/repository';
import { checkUsername } from '../users/username-policy';
import type { AccessTokenService } from './access-token';
import { checkPasswordStrength } from './password-policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const THROTTLE_FREE_FAILURES = 5;
const THROTTLE_MAX_LOCK_SECONDS = 15 * 60;
const RESEND_COOLDOWN_SECONDS = 60;

export interface ClientContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface SessionGrant {
  userId: string;
  sessionId: string;
  tokens: TokenPair;
}

type Trx = Transaction<DB>;

export class AuthService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly users: UserRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly mail: MailService,
    private readonly metrics: Metrics,
  ) {}

  // ------------------------------------------------------------------ signup / login

  async signup(input: SignupRequest, client: ClientContext): Promise<SessionGrant> {
    const now = this.clock.now();
    const email = normalizeEmail(input.email);

    if (!isRealDate(input.birthDate)) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'birthDate', message: 'Not a valid calendar date.' }],
      });
    }
    const age = ageOn(input.birthDate, now);
    if (age < 0 || age > 120) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'birthDate', message: 'Not a plausible birth date.' }],
      });
    }
    if (age < this.config.MIN_SIGNUP_AGE) throw new AppError('UNDER_MINIMUM_AGE');

    const usernameProblem = checkUsername(input.username);
    if (usernameProblem) {
      throw new AppError(usernameProblem === 'RESERVED' ? 'USERNAME_TAKEN' : 'VALIDATION_FAILED', {
        details: [
          {
            path: 'username',
            message: usernameProblem === 'RESERVED' ? 'Reserved.' : 'Invalid username.',
          },
        ],
      });
    }
    const weak = checkPasswordStrength(input.password, { email, username: input.username });
    if (weak) {
      throw new AppError('PASSWORD_TOO_WEAK', { details: [{ path: 'password', message: weak }] });
    }

    const passwordHash = await hashPassword(input.password);
    const isMinor = age < this.config.ADULT_AGE;
    const restrictPublic = age < this.config.MINOR_PUBLIC_MIN_AGE;
    const autoVerify = this.config.DEV_AUTO_VERIFY_EMAIL;

    const grant = await this.db.transaction().execute(async (trx) => {
      const userId = await this.users.createAccount(
        {
          email,
          passwordHash,
          birthDate: input.birthDate,
          username: input.username,
          displayName: input.displayName ?? input.username,
          emailVerifiedAt: autoVerify ? now : null,
          accountVisibility: restrictPublic ? 'PRIVATE' : 'PUBLIC',
          settings: {
            // Minors default to the most conservative audiences. These are defaults the user
            // can still tighten; loosening is bounded by age policy in the profile service.
            defaultActivityVisibility: isMinor ? 'PRIVATE' : 'FOLLOWERS',
            defaultPostVisibility: isMinor ? 'FOLLOWERS' : 'PUBLIC',
            defaultCommentPermission: isMinor ? 'FOLLOWERS' : 'EVERYONE',
            defaultRoutePrivacy: isMinor ? 'HIDDEN' : 'TRIMMED',
          },
        },
        trx,
      );
      if (!autoVerify)
        await this.issueEmailVerification(trx, userId, email, input.displayName ?? input.username);
      return this.createSession(trx, userId, input.device, client);
    });
    this.metrics.authEvents.inc({ event: 'signup' });
    return grant;
  }

  async login(input: LoginRequest, client: ClientContext): Promise<SessionGrant> {
    const email = normalizeEmail(input.email);
    await this.assertNotThrottled(email);

    const user = await this.users.findByEmail(email);
    const passwordOk = user?.passwordHash
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password); // equalise timing for unknown emails

    if (!user || !passwordOk) {
      await this.recordLoginFailure(email);
      this.metrics.authEvents.inc({ event: 'login_failed' });
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED');

    await this.db.deleteFrom('loginThrottles').where('email', '=', email).execute();
    const now = this.clock.now();
    const upgraded =
      user.passwordHash && needsRehash(user.passwordHash)
        ? await hashPassword(input.password)
        : null;

    const grant = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ lastLoginAt: now, ...(upgraded ? { passwordHash: upgraded } : {}) })
        .where('id', '=', user.id)
        .execute();
      return this.createSession(trx, user.id, input.device, client);
    });
    this.metrics.authEvents.inc({ event: 'login' });
    return grant;
  }

  // ------------------------------------------------------------------ refresh / logout

  /**
   * Rotates a refresh token. Presenting an already-used token proves replay/theft, so the whole
   * session is revoked (reuse detection). Errors are thrown after the transaction commits so the
   * revocation is never rolled back.
   */
  async refresh(
    refreshToken: string,
  ): Promise<{ sessionId: string; userId: string; tokens: TokenPair }> {
    const now = this.clock.now();
    const hash = hashToken(refreshToken);

    type Outcome =
      | { kind: 'ok'; userId: string; sessionId: string; refresh: string; refreshExpiresAt: Date }
      | { kind: 'invalid' | 'reused' | 'revoked' | 'suspended' };

    const outcome = await this.db.transaction().execute(async (trx): Promise<Outcome> => {
      const token = await trx
        .selectFrom('refreshTokens')
        .select(['id', 'sessionId', 'usedAt', 'expiresAt'])
        .where('tokenHash', '=', hash)
        .forUpdate()
        .executeTakeFirst();
      if (!token) return { kind: 'invalid' };

      const session = await trx
        .selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.userId')
        .select(['s.id', 's.userId', 's.expiresAt', 's.revokedAt', 'u.status'])
        .where('s.id', '=', token.sessionId)
        .executeTakeFirst();
      if (!session || session.revokedAt) return { kind: 'revoked' };

      if (token.usedAt) {
        await this.revokeSessionTx(trx, session.id, 'REFRESH_REUSE');
        return { kind: 'reused' };
      }
      if (token.expiresAt <= now || session.expiresAt <= now) return { kind: 'invalid' };
      if (session.status === 'SUSPENDED') return { kind: 'suspended' };

      const next = generateToken();
      const nextExpires = new Date(
        Math.min(
          now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
          session.expiresAt.getTime(),
        ),
      );
      const inserted = await trx
        .insertInto('refreshTokens')
        .values({ sessionId: session.id, tokenHash: hashToken(next), expiresAt: nextExpires })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('refreshTokens')
        .set({ usedAt: now, replacedBy: inserted.id })
        .where('id', '=', token.id)
        .execute();
      await trx
        .updateTable('sessions')
        .set({ lastSeenAt: now })
        .where('id', '=', session.id)
        .execute();
      return {
        kind: 'ok',
        userId: session.userId,
        sessionId: session.id,
        refresh: next,
        refreshExpiresAt: nextExpires,
      };
    });

    switch (outcome.kind) {
      case 'invalid':
        throw new AppError('REFRESH_TOKEN_INVALID');
      case 'reused':
        this.metrics.authEvents.inc({ event: 'refresh_reuse_detected' });
        throw new AppError('REFRESH_TOKEN_REUSED');
      case 'revoked':
        throw new AppError('SESSION_REVOKED');
      case 'suspended':
        throw new AppError('ACCOUNT_SUSPENDED');
      case 'ok': {
        const access = await this.accessTokens.sign(outcome.userId, outcome.sessionId);
        this.metrics.authEvents.inc({ event: 'refresh' });
        return {
          userId: outcome.userId,
          sessionId: outcome.sessionId,
          tokens: {
            tokenType: 'Bearer',
            accessToken: access.token,
            accessTokenExpiresAt: access.expiresAt.toISOString(),
            refreshToken: outcome.refresh,
            refreshTokenExpiresAt: outcome.refreshExpiresAt.toISOString(),
          },
        };
      }
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeSessionTx(this.db, sessionId, 'LOGOUT');
    this.metrics.authEvents.inc({ event: 'logout' });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.revokeAllSessions(this.db, userId, 'LOGOUT_ALL');
    this.metrics.authEvents.inc({ event: 'logout_all' });
  }

  // ------------------------------------------------------------------ email verification

  async verifyEmail(token: string): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      // Single atomic UPDATE ... RETURNING: concurrent attempts cannot both consume the token.
      const consumed = await trx
        .updateTable('authTokens')
        .set({ consumedAt: now })
        .where('tokenHash', '=', hashToken(token))
        .where('purpose', '=', 'EMAIL_VERIFICATION')
        .where('consumedAt', 'is', null)
        .where('expiresAt', '>', now)
        .returning('userId')
        .executeTakeFirst();
      if (!consumed) throw new AppError('TOKEN_CONSUMED_OR_EXPIRED');
      await trx
        .updateTable('users')
        .set({ emailVerifiedAt: now })
        .where('id', '=', consumed.userId)
        .where('emailVerifiedAt', 'is', null)
        .execute();
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (user.emailVerifiedAt) return;
    const now = this.clock.now();
    const recent = await this.db
      .selectFrom('authTokens')
      .select('createdAt')
      .where('userId', '=', userId)
      .where('purpose', '=', 'EMAIL_VERIFICATION')
      .where('createdAt', '>', new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000))
      .executeTakeFirst();
    if (recent) {
      throw new AppError('RATE_LIMITED', {
        headers: { 'retry-after': String(RESEND_COOLDOWN_SECONDS) },
      });
    }
    const profile = await this.db
      .selectFrom('profiles')
      .select('displayName')
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    await this.db
      .transaction()
      .execute((trx) => this.issueEmailVerification(trx, userId, user.email, profile.displayName));
  }

  // ------------------------------------------------------------------ passwords

  /** Always succeeds from the caller's perspective, so it cannot be used to probe for accounts. */
  async forgotPassword(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.users.findByEmail(email);
    if (!user || user.status === 'SUSPENDED') return;
    const now = this.clock.now();

    const recent = await this.db
      .selectFrom('authTokens')
      .select('id')
      .where('userId', '=', user.id)
      .where('purpose', '=', 'PASSWORD_RESET')
      .where('createdAt', '>', new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000))
      .executeTakeFirst();
    if (recent) return; // silently coalesce rapid repeats

    const profile = await this.db
      .selectFrom('profiles')
      .select('displayName')
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('authTokens')
        .set({ consumedAt: now })
        .where('userId', '=', user.id)
        .where('purpose', '=', 'PASSWORD_RESET')
        .where('consumedAt', 'is', null)
        .execute();
      const token = generateToken();
      await trx
        .insertInto('authTokens')
        .values({
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: hashToken(token),
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.config.PASSWORD_RESET_TTL_MINUTES * 60_000),
        })
        .execute();
      await this.mail.enqueue(
        {
          to: user.email,
          template: 'password_reset',
          displayName: profile.displayName,
          linkPrefix: 'reset-password?token=',
          token,
        },
        trx,
      );
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const now = this.clock.now();
    const row = await this.db
      .selectFrom('authTokens as t')
      .innerJoin('users as u', 'u.id', 't.userId')
      .innerJoin('profiles as p', 'p.userId', 'u.id')
      .select(['t.userId', 'u.email', 'p.username', 'p.displayName'])
      .where('t.tokenHash', '=', hashToken(token))
      .where('t.purpose', '=', 'PASSWORD_RESET')
      .where('t.consumedAt', 'is', null)
      .where('t.expiresAt', '>', now)
      .executeTakeFirst();
    if (!row) throw new AppError('TOKEN_CONSUMED_OR_EXPIRED');

    const weak = checkPasswordStrength(newPassword, { email: row.email, username: row.username });
    if (weak)
      throw new AppError('PASSWORD_TOO_WEAK', {
        details: [{ path: 'newPassword', message: weak }],
      });
    const passwordHash = await hashPassword(newPassword);

    await this.db.transaction().execute(async (trx) => {
      const consumed = await trx
        .updateTable('authTokens')
        .set({ consumedAt: now })
        .where('tokenHash', '=', hashToken(token))
        .where('consumedAt', 'is', null)
        .where('expiresAt', '>', now)
        .returning('userId')
        .executeTakeFirst();
      if (!consumed) throw new AppError('TOKEN_CONSUMED_OR_EXPIRED');
      await trx
        .updateTable('users')
        .set({
          passwordHash,
          passwordChangedAt: now,
          // Receiving the reset email proves control of the address.
          emailVerifiedAt: sql<Date>`coalesce(email_verified_at, ${now})`,
        })
        .where('id', '=', row.userId)
        .execute();
      await trx
        .updateTable('loginThrottles')
        .set({ failureCount: 0, lockedUntil: null })
        .where('email', '=', row.email)
        .execute();
      await this.revokeAllSessions(trx, row.userId, 'PASSWORD_RESET');
      await this.mail.enqueue(
        { to: row.email, template: 'password_changed', displayName: row.displayName },
        trx,
      );
    });
    this.metrics.authEvents.inc({ event: 'password_reset' });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    current: string,
    next: string,
  ): Promise<void> {
    const user = await this.requireUser(userId);
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, current))) {
      throw new AppError('PASSWORD_INCORRECT');
    }
    const profile = await this.db
      .selectFrom('profiles')
      .select(['username', 'displayName'])
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    const weak = checkPasswordStrength(next, { email: user.email, username: profile.username });
    if (weak)
      throw new AppError('PASSWORD_TOO_WEAK', {
        details: [{ path: 'newPassword', message: weak }],
      });
    const passwordHash = await hashPassword(next);
    const now = this.clock.now();

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ passwordHash, passwordChangedAt: now })
        .where('id', '=', userId)
        .execute();
      await this.revokeAllSessions(trx, userId, 'PASSWORD_CHANGED', currentSessionId);
      await this.mail.enqueue(
        { to: user.email, template: 'password_changed', displayName: profile.displayName },
        trx,
      );
    });
  }

  // ------------------------------------------------------------------ sessions & devices

  async listSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('sessions as s')
      .leftJoin('devices as d', 'd.id', 's.deviceId')
      .select([
        's.id',
        's.createdAt',
        's.lastSeenAt',
        's.expiresAt',
        's.ipPrefix',
        'd.id as deviceId',
        'd.name as deviceName',
        'd.platform',
        'd.appVersion',
      ])
      .where('s.userId', '=', userId)
      .where('s.revokedAt', 'is', null)
      .where('s.expiresAt', '>', now)
      .orderBy('s.lastSeenAt', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      isCurrent: r.id === currentSessionId,
      device:
        r.deviceId && r.platform
          ? { id: r.deviceId, name: r.deviceName, platform: r.platform, appVersion: r.appVersion }
          : null,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      approximateNetwork: r.ipPrefix,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const res = await this.db
      .updateTable('sessions')
      .set({ revokedAt: this.clock.now(), revokedReason: 'USER_REVOKED' })
      .where('id', '=', sessionId)
      .where('userId', '=', userId) // ownership enforced in the predicate: cannot revoke others' sessions
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw new AppError('SESSION_NOT_FOUND');
  }

  // ------------------------------------------------------------------ account deletion

  async requestDeletion(
    userId: string,
    currentSessionId: string,
    password: string,
  ): Promise<{ requestedAt: Date; scheduledFor: Date }> {
    const user = await this.requireUser(userId);
    if (
      user.status === 'PENDING_DELETION' &&
      user.deletionRequestedAt &&
      user.deletionScheduledFor
    ) {
      return { requestedAt: user.deletionRequestedAt, scheduledFor: user.deletionScheduledFor };
    }
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new AppError('PASSWORD_INCORRECT');
    }
    const profile = await this.db
      .selectFrom('profiles')
      .select('displayName')
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    const requestedAt = this.clock.now();
    const scheduledFor = new Date(
      requestedAt.getTime() + this.config.ACCOUNT_DELETION_GRACE_DAYS * DAY_MS,
    );

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          status: 'PENDING_DELETION',
          deletionRequestedAt: requestedAt,
          deletionScheduledFor: scheduledFor,
        })
        .where('id', '=', userId)
        .where('status', '=', 'ACTIVE')
        .execute();
      // Keep only the current session (restricted mode) so the user can still cancel.
      await this.revokeAllSessions(trx, userId, 'ACCOUNT_DELETION', currentSessionId);
      await this.mail.enqueue(
        {
          to: user.email,
          template: 'account_deletion_scheduled',
          displayName: profile.displayName,
          scheduledFor: scheduledFor.toISOString(),
        },
        trx,
      );
    });
    return { requestedAt, scheduledFor };
  }

  async cancelDeletion(userId: string): Promise<void> {
    const res = await this.db
      .updateTable('users')
      .set({ status: 'ACTIVE', deletionRequestedAt: null, deletionScheduledFor: null })
      .where('id', '=', userId)
      .where('status', '=', 'PENDING_DELETION')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0)
      throw new AppError('INVALID_STATE', { message: 'No deletion is scheduled.' });
  }

  // ------------------------------------------------------------------ maintenance

  /** Removes expired/consumed tokens, dead sessions and stale throttles. Run by a scheduled job. */
  async purgeExpired(): Promise<void> {
    const now = this.clock.now();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    await this.db
      .deleteFrom('authTokens')
      .where((eb) => eb.or([eb('expiresAt', '<', weekAgo), eb('consumedAt', '<', weekAgo)]))
      .execute();
    await this.db.deleteFrom('refreshTokens').where('expiresAt', '<', weekAgo).execute();
    await this.db
      .deleteFrom('sessions')
      .where((eb) => eb.or([eb('expiresAt', '<', weekAgo), eb('revokedAt', '<', weekAgo)]))
      .execute();
    await this.db
      .deleteFrom('loginThrottles')
      .where('updatedAt', '<', new Date(now.getTime() - DAY_MS))
      .execute();
    await this.db.deleteFrom('idempotencyKeys').where('expiresAt', '<', now).execute();
  }

  // ------------------------------------------------------------------ internals

  private async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('USER_NOT_FOUND');
    return user;
  }

  private async issueEmailVerification(
    trx: Trx,
    userId: string,
    email: string,
    displayName: string,
  ): Promise<void> {
    const now = this.clock.now();
    await trx
      .updateTable('authTokens')
      .set({ consumedAt: now })
      .where('userId', '=', userId)
      .where('purpose', '=', 'EMAIL_VERIFICATION')
      .where('consumedAt', 'is', null)
      .execute();
    const token = generateToken();
    await trx
      .insertInto('authTokens')
      .values({
        userId,
        purpose: 'EMAIL_VERIFICATION',
        tokenHash: hashToken(token),
        createdAt: now, // app clock: the resend cooldown compares against it
        expiresAt: new Date(now.getTime() + this.config.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000),
      })
      .execute();
    await this.mail.enqueue(
      {
        to: email,
        template: 'verify_email',
        displayName,
        linkPrefix: 'verify-email?token=',
        token,
      },
      trx,
    );
  }

  private async createSession(
    trx: Trx,
    userId: string,
    device: DeviceInfo | undefined,
    client: ClientContext,
  ): Promise<SessionGrant> {
    const now = this.clock.now();
    let deviceId: string | null = null;
    if (device) {
      const row = await trx
        .insertInto('devices')
        .values({
          userId,
          installId: device.installId,
          platform: device.platform,
          name: device.name ?? null,
          appVersion: device.appVersion ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['userId', 'installId']).doUpdateSet({
            platform: device.platform,
            name: device.name ?? null,
            appVersion: device.appVersion ?? null,
            lastSeenAt: now,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      deviceId = row.id;
    }
    const sessionExpires = new Date(now.getTime() + this.config.SESSION_MAX_AGE_DAYS * DAY_MS);
    const session = await trx
      .insertInto('sessions')
      .values({
        userId,
        deviceId,
        expiresAt: sessionExpires,
        lastSeenAt: now,
        ipPrefix: ipPrefix(client.ip),
        userAgent: client.userAgent?.slice(0, 256) ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const refresh = generateToken();
    const refreshExpires = new Date(
      Math.min(
        now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
        sessionExpires.getTime(),
      ),
    );
    await trx
      .insertInto('refreshTokens')
      .values({ sessionId: session.id, tokenHash: hashToken(refresh), expiresAt: refreshExpires })
      .execute();
    const access = await this.accessTokens.sign(userId, session.id);
    return {
      userId,
      sessionId: session.id,
      tokens: {
        tokenType: 'Bearer',
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: refresh,
        refreshTokenExpiresAt: refreshExpires.toISOString(),
      },
    };
  }

  private async revokeSessionTx(
    db: Db | Trx,
    sessionId: string,
    reason: 'LOGOUT' | 'REFRESH_REUSE',
  ): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revokedAt: this.clock.now(), revokedReason: reason })
      .where('id', '=', sessionId)
      .where('revokedAt', 'is', null)
      .execute();
  }

  private async revokeAllSessions(
    db: Db | Trx,
    userId: string,
    reason: 'LOGOUT_ALL' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET' | 'ACCOUNT_DELETION',
    exceptSessionId?: string,
  ): Promise<void> {
    let q = db
      .updateTable('sessions')
      .set({ revokedAt: this.clock.now(), revokedReason: reason })
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null);
    if (exceptSessionId) q = q.where('id', '!=', exceptSessionId);
    await q.execute();
  }

  // ---- per-account login throttling (progressive delay, never a permanent lock) ----------

  private async assertNotThrottled(email: string): Promise<void> {
    const row = await this.db
      .selectFrom('loginThrottles')
      .select('lockedUntil')
      .where('email', '=', email)
      .executeTakeFirst();
    const now = this.clock.now();
    if (row?.lockedUntil && row.lockedUntil > now) {
      const seconds = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000);
      throw new AppError('RATE_LIMITED', { headers: { 'retry-after': String(seconds) } });
    }
  }

  private async recordLoginFailure(email: string): Promise<void> {
    const now = this.clock.now();
    const row = await this.db
      .insertInto('loginThrottles')
      .values({ email, failureCount: 1, updatedAt: now })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet((eb) => ({
          failureCount: eb('loginThrottles.failureCount', '+', 1),
          updatedAt: now,
        })),
      )
      .returning('failureCount')
      .executeTakeFirstOrThrow();
    if (row.failureCount >= THROTTLE_FREE_FAILURES) {
      const lockSeconds = Math.min(
        THROTTLE_MAX_LOCK_SECONDS,
        30 * 2 ** (row.failureCount - THROTTLE_FREE_FAILURES),
      );
      await this.db
        .updateTable('loginThrottles')
        .set({ lockedUntil: new Date(now.getTime() + lockSeconds * 1000) })
        .where('email', '=', email)
        .execute();
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
