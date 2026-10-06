import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  PageQuerySchema,
  PostPageSchema,
  SuggestedAthletePageSchema,
  TopicResultSchema,
  TopicSlugParamSchema,
  TrendingQuerySchema,
  TrendingTopicsSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function discoveryRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limits = rateLimitConfig(RATE_LIMITS.search);

  r.route({
    method: 'GET',
    url: '/discover/athletes',
    onRequest: app.requireAuth,
    config: limits,
    schema: {
      tags: ['Discover'],
      operationId: 'suggestAthletes',
      summary: 'Who to follow',
      description:
        'People followed by people you follow, people who share your sports, then popular and creator accounts. ' +
        'Excludes yourself, people you follow or requested, blocked users and accounts that opted out. Capped at 200.',
      security: BEARER_SECURITY,
      querystring: PageQuerySchema,
      response: { 200: SuggestedAthletePageSchema, ...errors(400, 401, 429) },
    },
    handler: async (req) => s.discovery.suggestedAthletes(actor(req).userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/discover/topics',
    onRequest: app.optionalAuth,
    config: limits,
    schema: {
      tags: ['Discover'],
      operationId: 'listTrendingTopics',
      summary: 'Trending topics (last 7 days, used by at least two different people)',
      security: [{}, ...BEARER_SECURITY],
      querystring: TrendingQuerySchema,
      response: { 200: TrendingTopicsSchema, ...errors(400, 401, 429) },
    },
    handler: async (req) => ({ items: await s.discovery.trendingTopics(req.query.limit) }),
  });

  r.route({
    method: 'GET',
    url: '/topics/:slug',
    onRequest: app.optionalAuth,
    config: limits,
    schema: {
      tags: ['Discover'],
      operationId: 'getTopic',
      summary: 'A topic and how many public posts use it',
      security: [{}, ...BEARER_SECURITY],
      params: TopicSlugParamSchema,
      response: { 200: TopicResultSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) => s.discovery.topic(req.params.slug),
  });

  r.route({
    method: 'GET',
    url: '/topics/:slug/posts',
    onRequest: app.optionalAuth,
    config: limits,
    schema: {
      tags: ['Discover'],
      operationId: 'listTopicPosts',
      summary: 'Posts using a topic, newest first',
      description:
        'Anonymous visitors see public posts of public accounts; signed-in users also see what their follows allow.',
      security: [{}, ...BEARER_SECURITY],
      params: TopicSlugParamSchema,
      querystring: PageQuerySchema,
      response: { 200: PostPageSchema, ...errors(400, 401, 404, 429) },
    },
    handler: async (req) =>
      s.discovery.topicPosts(req.auth?.userId ?? null, req.params.slug, req.query),
  });
}
