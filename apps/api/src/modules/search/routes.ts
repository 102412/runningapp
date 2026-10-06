import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  PostPageSchema,
  SearchOverviewQuerySchema,
  SearchOverviewSchema,
  SearchQuerySchema,
  TopicPageSchema,
  UserSearchPageSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function searchRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limits = rateLimitConfig(RATE_LIMITS.search);
  const base = { onRequest: app.requireAuth, config: limits };
  const note =
    'Results never include blocked users, private accounts you do not follow, ' +
    'accounts that opted out of discovery, or accounts under the minimum public age.';

  r.route({
    ...base,
    method: 'GET',
    url: '/search',
    schema: {
      tags: ['Search'],
      operationId: 'search',
      summary: 'Search overview: the top few users, topics and posts',
      description: `Use it for the first screen of results; page through one kind with the typed endpoints. ${note}`,
      security: BEARER_SECURITY,
      querystring: SearchOverviewQuerySchema,
      response: { 200: SearchOverviewSchema, ...errors(400, 401, 422, 429) },
    },
    handler: async (req) => s.search.overview(actor(req).userId, req.query.q),
  });

  r.route({
    ...base,
    method: 'GET',
    url: '/search/users',
    schema: {
      tags: ['Search'],
      operationId: 'searchUsers',
      summary: 'Find people by username or name (exact and prefix matches rank first)',
      description: `Tolerates small typos. ${note} Results are capped at 500.`,
      security: BEARER_SECURITY,
      querystring: SearchQuerySchema,
      response: { 200: UserSearchPageSchema, ...errors(400, 401, 422, 429) },
    },
    handler: async (req) => s.search.users(actor(req).userId, req.query.q, req.query),
  });

  r.route({
    ...base,
    method: 'GET',
    url: '/search/posts',
    schema: {
      tags: ['Search'],
      operationId: 'searchPosts',
      summary: 'Find posts by caption text or topic',
      description: `The last word is matched as a prefix. ${note} Results are capped at 500.`,
      security: BEARER_SECURITY,
      querystring: SearchQuerySchema,
      response: { 200: PostPageSchema, ...errors(400, 401, 422, 429) },
    },
    handler: async (req) => s.search.posts(actor(req).userId, req.query.q, req.query),
  });

  r.route({
    ...base,
    method: 'GET',
    url: '/search/topics',
    schema: {
      tags: ['Search'],
      operationId: 'searchTopics',
      summary: 'Find topics (hashtags) that public posts use',
      security: BEARER_SECURITY,
      querystring: SearchQuerySchema,
      response: { 200: TopicPageSchema, ...errors(400, 401, 422, 429) },
    },
    handler: async (req) => s.search.topics(actor(req).userId, req.query.q, req.query),
  });
}
