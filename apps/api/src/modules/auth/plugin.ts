import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { UserRole } from '@runningapp/contracts';
import { AppError } from '../../platform/errors';
import type { PlatformContext } from '../../platform/context';
import type { AccessTokenService } from './access-token';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Allow principals whose account is SUSPENDED or PENDING_DELETION. Only for the handful of
     * routes such users legitimately need (view own account, cancel deletion, log out).
     */
    allowRestricted?: boolean;
  }
  interface FastifyInstance {
    /** Requires a valid bearer token backed by a live session. Sets `request.auth`. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Like requireAuth but anonymous requests pass (a *presented* bad token still fails). */
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** requireAuth + email verified (when REQUIRE_VERIFIED_EMAIL_TO_PUBLISH). For creating content. */
    requireVerified: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** requireAuth + at least this role (ADMIN > MODERATOR > USER). */
    requireRole: (
      role: Exclude<UserRole, 'USER'>,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ROLE_RANK: Record<UserRole, number> = { USER: 0, MODERATOR: 1, ADMIN: 2 };
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;
const BEARER = /^Bearer\s+(\S+)$/i;

export function authPlugin(platform: PlatformContext, tokens: AccessTokenService) {
  return fp(
    async (app: FastifyInstance) => {
      async function authenticate(request: FastifyRequest, required: boolean): Promise<void> {
        const header = request.headers.authorization;
        if (header === undefined) {
          if (required) throw new AppError('UNAUTHENTICATED');
          return;
        }
        const match = BEARER.exec(header);
        if (!match?.[1]) throw new AppError('TOKEN_INVALID');
        const claims = await tokens.verify(match[1]);

        // The JWT only proves issuance. Liveness (revocation, suspension, deletion) is checked
        // against the database so logout and moderation take effect immediately.
        const row = await platform.db
          .selectFrom('sessions as s')
          .innerJoin('users as u', 'u.id', 's.userId')
          .select([
            's.id',
            's.expiresAt',
            's.revokedAt',
            's.lastSeenAt',
            'u.id as userId',
            'u.status',
            'u.role',
            'u.emailVerifiedAt',
          ])
          .where('s.id', '=', claims.sessionId)
          .where('s.userId', '=', claims.userId)
          .executeTakeFirst();
        const now = platform.clock.now();
        if (!row || row.revokedAt || row.expiresAt <= now) throw new AppError('SESSION_REVOKED');

        const allowRestricted = request.routeOptions.config.allowRestricted === true;
        if (!allowRestricted) {
          if (row.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED');
          if (row.status === 'PENDING_DELETION') throw new AppError('ACCOUNT_PENDING_DELETION');
        }

        request.auth = {
          userId: row.userId,
          sessionId: row.id,
          role: row.role,
          emailVerified: row.emailVerifiedAt !== null,
        };

        if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
          // Best-effort; never fail the request over a bookkeeping write.
          void platform.db
            .updateTable('sessions')
            .set({ lastSeenAt: now })
            .where('id', '=', row.id)
            .execute()
            .catch((err: unknown) =>
              platform.logger.warn({ err }, 'failed to update session last_seen_at'),
            );
        }
      }

      app.decorate('requireAuth', (request: FastifyRequest) => authenticate(request, true));
      app.decorate('optionalAuth', (request: FastifyRequest) => authenticate(request, false));
      app.decorate('requireVerified', async (request: FastifyRequest) => {
        await authenticate(request, true);
        if (platform.config.REQUIRE_VERIFIED_EMAIL_TO_PUBLISH && !request.auth?.emailVerified) {
          throw new AppError('EMAIL_NOT_VERIFIED');
        }
      });
      app.decorate(
        'requireRole',
        (role: Exclude<UserRole, 'USER'>) => async (request: FastifyRequest) => {
          await authenticate(request, true);
          const actual = request.auth?.role ?? 'USER';
          if (ROLE_RANK[actual] < ROLE_RANK[role]) throw new AppError('INSUFFICIENT_ROLE');
        },
      );
    },
    { name: 'auth-guards' },
  );
}
