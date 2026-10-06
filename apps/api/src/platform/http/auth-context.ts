import type { UserRole } from '@runningapp/contracts';

/** The authenticated principal for a request (identity only — authorization lives in policies). */
export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
  emailVerified: boolean;
}

import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';

/**
 * The authenticated principal for a request. Use inside handlers of routes guarded by
 * `requireAuth`; throws UNAUTHENTICATED if a route was wired without a guard by mistake
 * (fail closed, never run a handler without an actor).
 */
export function actor(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED');
  return request.auth;
}
