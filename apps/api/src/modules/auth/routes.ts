import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuthResponseSchema,
  ChangePasswordRequestSchema,
  DeletionStatusSchema,
  ForgotPasswordRequestSchema,
  IdSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  RequestDeletionRequestSchema,
  ResetPasswordRequestSchema,
  SessionListSchema,
  SignupRequestSchema,
  TokenRefreshResponseSchema,
  UsernameAvailabilityQuerySchema,
  UsernameAvailabilitySchema,
  VerifyEmailRequestSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function authRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const client = (req: { ip: string; headers: Record<string, string | string[] | undefined> }) => ({
    ip: req.ip,
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  });

  r.route({
    method: 'POST',
    url: '/auth/signup',
    config: rateLimitConfig(RATE_LIMITS.authSignup),
    schema: {
      tags: ['Auth'],
      operationId: 'signup',
      summary: 'Create an account and sign in',
      description:
        'Returns tokens immediately. Users under the adult age get private-by-default settings. A verification email is sent; until verified, publishing is blocked (`EMAIL_NOT_VERIFIED`) when the server enforces it.',
      body: SignupRequestSchema,
      response: { 201: AuthResponseSchema, ...errors(403, 409, 422, 429) },
    },
    handler: async (req, reply) => {
      const grant = await s.auth.signup(req.body, client(req));
      const user = await s.profiles.getMe(grant.userId);
      return reply.status(201).send({ user, tokens: grant.tokens, sessionId: grant.sessionId });
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/login',
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'login',
      summary: 'Sign in with email and password',
      description:
        'Repeated failures for one email are progressively throttled (`RATE_LIMITED` with `Retry-After`). Accounts scheduled for deletion can sign in (restricted mode) so they can cancel.',
      body: LoginRequestSchema,
      response: { 200: AuthResponseSchema, ...errors(401, 403, 422, 429) },
    },
    handler: async (req) => {
      const grant = await s.auth.login(req.body, client(req));
      const user = await s.profiles.getMe(grant.userId);
      return { user, tokens: grant.tokens, sessionId: grant.sessionId };
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/refresh',
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'refreshTokens',
      summary: 'Exchange a refresh token for a new token pair',
      description:
        'Refresh tokens are single-use and rotate on every call. Re-presenting a used token revokes the whole session (`REFRESH_TOKEN_REUSED`). Clients must serialise refresh calls (the provided api-client does).',
      body: RefreshRequestSchema,
      response: { 200: TokenRefreshResponseSchema, ...errors(401, 403, 422, 429) },
    },
    handler: async (req) => {
      const { tokens } = await s.auth.refresh(req.body.refreshToken);
      return { tokens };
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/logout',
    onRequest: app.requireAuth,
    config: { allowRestricted: true },
    schema: {
      tags: ['Auth'],
      operationId: 'logout',
      summary: 'Revoke the current session',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.auth.logout(actor(req).sessionId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/logout-all',
    onRequest: app.requireAuth,
    config: { allowRestricted: true },
    schema: {
      tags: ['Auth'],
      operationId: 'logoutAll',
      summary: 'Revoke every session on every device',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.auth.logoutAll(actor(req).userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/verify-email',
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'verifyEmail',
      summary: 'Confirm an email address with the emailed token',
      body: VerifyEmailRequestSchema,
      response: { 204: NoContent, ...errors(410, 422, 429) },
    },
    handler: async (req, reply) => {
      await s.auth.verifyEmail(req.body.token);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/verify-email/resend',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'resendVerificationEmail',
      summary: 'Send a new verification email (max one per minute)',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401, 429) },
    },
    handler: async (req, reply) => {
      await s.auth.resendVerification(actor(req).userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/password/forgot',
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'forgotPassword',
      summary: 'Request a password-reset email',
      description:
        'Always answers 202 regardless of whether the email is registered, so it cannot be used to discover accounts.',
      body: ForgotPasswordRequestSchema,
      response: { 202: NoContent, ...errors(422, 429) },
    },
    handler: async (req, reply) => {
      await s.auth.forgotPassword(req.body.email);
      return reply.status(202).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/password/reset',
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'resetPassword',
      summary: 'Set a new password using the emailed token',
      description: 'Revokes every session of the account.',
      body: ResetPasswordRequestSchema,
      response: { 204: NoContent, ...errors(410, 422, 429) },
    },
    handler: async (req, reply) => {
      await s.auth.resetPassword(req.body.token, req.body.newPassword);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/auth/password/change',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Auth'],
      operationId: 'changePassword',
      summary: 'Change password (signs out all other sessions)',
      security: BEARER_SECURITY,
      body: ChangePasswordRequestSchema,
      response: { 204: NoContent, ...errors(401, 422, 429) },
    },
    handler: async (req, reply) => {
      await s.auth.changePassword(
        actor(req).userId,
        actor(req).sessionId,
        req.body.currentPassword,
        req.body.newPassword,
      );
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/auth/sessions',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Auth'],
      operationId: 'listSessions',
      summary: 'List active sessions (devices) for the account',
      security: BEARER_SECURITY,
      response: { 200: SessionListSchema, ...errors(401) },
    },
    handler: async (req) => ({
      items: await s.auth.listSessions(actor(req).userId, actor(req).sessionId),
    }),
  });

  r.route({
    method: 'DELETE',
    url: '/auth/sessions/:sessionId',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Auth'],
      operationId: 'revokeSession',
      summary: 'Sign out one specific session',
      security: BEARER_SECURITY,
      params: z.object({ sessionId: IdSchema }),
      response: { 204: NoContent, ...errors(401, 404) },
    },
    handler: async (req, reply) => {
      await s.auth.revokeSession(actor(req).userId, req.params.sessionId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/auth/username-available',
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Auth'],
      operationId: 'checkUsernameAvailability',
      summary: 'Check whether a username can be registered',
      querystring: UsernameAvailabilityQuerySchema,
      response: { 200: UsernameAvailabilitySchema, ...errors(422, 429) },
    },
    handler: async (req) => s.profiles.usernameAvailability(req.query.username),
  });

  // ---- account deletion workflow -------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/me/account/deletion',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Me'],
      operationId: 'requestAccountDeletion',
      summary: 'Schedule account deletion (re-authenticates with password)',
      description:
        'The account is hidden immediately and permanently deleted after the grace period (default 30 days). Other sessions are revoked; this session stays in restricted mode so the user can cancel. Signing in also works in restricted mode.',
      security: BEARER_SECURITY,
      body: RequestDeletionRequestSchema,
      response: { 200: DeletionStatusSchema, ...errors(401, 422, 429) },
    },
    handler: async (req) => {
      const d = await s.auth.requestDeletion(
        actor(req).userId,
        actor(req).sessionId,
        req.body.password,
      );
      return {
        requestedAt: d.requestedAt.toISOString(),
        scheduledFor: d.scheduledFor.toISOString(),
      };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/me/account/deletion',
    onRequest: app.requireAuth,
    config: { allowRestricted: true },
    schema: {
      tags: ['Me'],
      operationId: 'cancelAccountDeletion',
      summary: 'Cancel a scheduled account deletion',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401, 409) },
    },
    handler: async (req, reply) => {
      await s.auth.cancelDeletion(actor(req).userId);
      return reply.status(204).send();
    },
  });
}
