import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { EventBatchRequestSchema, EventBatchResultSchema } from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function eventRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'POST',
    url: '/events',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.events),
    schema: {
      tags: ['Events'],
      operationId: 'recordEvents',
      summary: 'Report what the user saw and did (impressions, watch time, "not interested"...)',
      description:
        'Send events in batches (up to 100) every few seconds or when the app backgrounds. ' +
        'Idempotent per `eventId`. Likes, comments, shares, bookmarks and follows are recorded by their own endpoints. ' +
        'Events about content the user cannot see are returned in `rejected`.',
      security: BEARER_SECURITY,
      body: EventBatchRequestSchema,
      response: { 200: EventBatchResultSchema, ...errors(400, 401, 422, 429) },
    },
    handler: async (req) => s.eventIngestion.ingest(actor(req).userId, req.body.events),
  });
}
