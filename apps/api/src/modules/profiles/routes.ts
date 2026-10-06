import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  IdSchema,
  MeSchema,
  ProfileSchema,
  SettingsSchema,
  UpdateProfileRequestSchema,
  UpdateSettingsRequestSchema,
  UserIdParamSchema,
  UsernameParamSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function profileRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/me',
    onRequest: app.requireAuth,
    config: { allowRestricted: true },
    schema: {
      tags: ['Me'],
      operationId: 'getMe',
      summary: 'The signed-in account: identity, profile, settings, deletion state',
      description:
        'Works for suspended and pending-deletion accounts so clients can show the right screen.',
      security: BEARER_SECURITY,
      response: { 200: MeSchema, ...errors(401) },
    },
    handler: async (req) => s.profiles.getMe(actor(req).userId),
  });

  r.route({
    method: 'PATCH',
    url: '/me/profile',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Me'],
      operationId: 'updateProfile',
      summary: 'Update display name, bio, username, location label, primary sport',
      description:
        'Changing to a *different* username is limited to once per 14 days (`USERNAME_CHANGE_COOLDOWN`).',
      security: BEARER_SECURITY,
      body: UpdateProfileRequestSchema,
      response: { 200: ProfileSchema, ...errors(401, 409, 422, 429) },
    },
    handler: async (req) => s.profiles.updateProfile(actor(req).userId, req.body),
  });

  r.route({
    method: 'PUT',
    url: '/me/avatar',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Me'],
      operationId: 'setAvatar',
      summary: 'Use a READY avatar image as your profile picture',
      description:
        'Upload an image with `purpose: "AVATAR"` via /media/uploads first. Avatars are centre-cropped to a square.',
      security: BEARER_SECURITY,
      body: z.object({ mediaId: IdSchema }).strict(),
      response: { 200: ProfileSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req) => s.profiles.setAvatar(actor(req).userId, req.body.mediaId),
  });

  r.route({
    method: 'DELETE',
    url: '/me/avatar',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'removeAvatar',
      summary: 'Remove your profile picture',
      security: BEARER_SECURITY,
      response: { 200: ProfileSchema, ...errors(401) },
    },
    handler: async (req) => s.profiles.setAvatar(actor(req).userId, null),
  });

  r.route({
    method: 'GET',
    url: '/me/settings',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'getSettings',
      summary: 'Privacy and preference settings',
      security: BEARER_SECURITY,
      response: { 200: SettingsSchema, ...errors(401) },
    },
    handler: async (req) => s.profiles.getSettings(actor(req).userId),
  });

  r.route({
    method: 'PATCH',
    url: '/me/settings',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Me'],
      operationId: 'updateSettings',
      summary: 'Update privacy and preference settings (partial)',
      description:
        'Switching `accountVisibility` PRIVATE -> PUBLIC approves all pending follow requests. Users under the public-account age cannot select PUBLIC (`PUBLIC_ACCOUNT_NOT_ALLOWED`).',
      security: BEARER_SECURITY,
      body: UpdateSettingsRequestSchema,
      response: { 200: SettingsSchema, ...errors(401, 403, 422, 429) },
    },
    handler: async (req) => s.profiles.updateSettings(actor(req).userId, req.body),
  });

  r.route({
    method: 'GET',
    url: '/users/:userId',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Users'],
      operationId: 'getUser',
      summary: 'A user profile as seen by the caller',
      description:
        'Anonymous access is allowed. Blocked pairs, suspended and pending-deletion accounts all return `USER_NOT_FOUND`. Private accounts return the header and counts; their posts are visible only to approved followers.',
      security: [{}, ...BEARER_SECURITY],
      params: UserIdParamSchema,
      response: { 200: ProfileSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) =>
      s.profiles.getProfile(req.auth?.userId ?? null, { id: req.params.userId }),
  });

  r.route({
    method: 'GET',
    url: '/users/by-username/:username',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Users'],
      operationId: 'getUserByUsername',
      summary: 'A user profile by @username (case-insensitive)',
      security: [{}, ...BEARER_SECURITY],
      params: UsernameParamSchema,
      response: { 200: ProfileSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req) =>
      s.profiles.getProfile(req.auth?.userId ?? null, { username: req.params.username }),
  });
}
