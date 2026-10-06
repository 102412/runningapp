import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { FeedPageSchema, FeedQuerySchema } from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function feedRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limits = rateLimitConfig(RATE_LIMITS.search);

  r.route({
    method: 'GET',
    url: '/feed/following',
    onRequest: app.requireAuth,
    config: limits,
    schema: {
      tags: ['Feed'],
      operationId: 'getFollowingFeed',
      summary: 'Chronological feed: posts from people you follow, plus your own',
      description:
        'Unranked, newest first, infinite. Keyset pagination: new posts never shift or repeat earlier pages.',
      security: BEARER_SECURITY,
      querystring: FeedQuerySchema,
      response: { 200: FeedPageSchema, ...errors(400, 401, 429) },
    },
    handler: async (req) => s.feed.following(actor(req).userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/feed/home',
    onRequest: app.requireAuth,
    config: limits,
    schema: {
      tags: ['Feed'],
      operationId: 'getHomeFeed',
      summary: 'Ranked home feed: people you follow, mixed with discovery',
      description:
        'A finite ranked list frozen at refresh (omit `cursor` to refresh). Pages walk that list exactly once. ' +
        'Expired cursors answer `FEED_EXPIRED` (410): refresh from the top. ' +
        'Sponsored posts always carry `sponsorship` — render its `label`.',
      security: BEARER_SECURITY,
      querystring: FeedQuerySchema,
      response: { 200: FeedPageSchema, ...errors(400, 401, 410, 429) },
    },
    handler: async (req) => s.feed.home(actor(req).userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/feed/explore',
    onRequest: app.requireAuth,
    config: limits,
    schema: {
      tags: ['Feed'],
      operationId: 'getExploreFeed',
      summary: 'Discovery feed: public posts from people you do not follow',
      description:
        'Same snapshot paging as the home feed. Only posts from discoverable authors that you may see; ' +
        'blocked users and posts you marked "not interested" never appear.',
      security: BEARER_SECURITY,
      querystring: FeedQuerySchema,
      response: { 200: FeedPageSchema, ...errors(400, 401, 410, 429) },
    },
    handler: async (req) => s.feed.explore(actor(req).userId, req.query),
  });
}
