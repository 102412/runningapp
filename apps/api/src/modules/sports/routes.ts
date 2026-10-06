import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  SetSportPreferencesRequestSchema,
  SportListSchema,
  SportPreferencesSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function sportRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/sports',
    schema: {
      tags: ['Sports'],
      operationId: 'listSports',
      summary: 'Supported sports and which metrics each one supports',
      description: 'Public reference data. Cacheable for a minute.',
      response: { 200: SportListSchema },
    },
    handler: async (_req, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return { items: await s.sports.list() };
    },
  });

  r.route({
    method: 'GET',
    url: '/me/sports',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'getSportPreferences',
      summary: 'Your explicit sport interests (used for onboarding and ranking)',
      security: BEARER_SECURITY,
      response: { 200: SportPreferencesSchema, ...errors(401) },
    },
    handler: async (req) => ({ items: await s.sports.getPreferences(actor(req).userId) }),
  });

  r.route({
    method: 'PUT',
    url: '/me/sports',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'setSportPreferences',
      summary: 'Replace your sport interests',
      security: BEARER_SECURITY,
      body: SetSportPreferencesRequestSchema,
      response: { 200: SportPreferencesSchema, ...errors(401, 422) },
    },
    handler: async (req) => ({
      items: await s.sports.setPreferences(actor(req).userId, req.body.items),
    }),
  });
}
