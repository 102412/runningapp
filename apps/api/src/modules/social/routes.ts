import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BlockedUserPageSchema,
  FollowRequestIdParamSchema,
  FollowRequestPageSchema,
  FollowResultSchema,
  SocialListQuerySchema,
  UserIdParamSchema,
  UserSummaryPageSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function socialRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'POST',
    url: '/users/:userId/follow',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.engagement),
    schema: {
      tags: ['Social'],
      operationId: 'followUser',
      summary: 'Follow a user (or request to follow a private account)',
      description:
        'Idempotent. `FOLLOWING` for public accounts; `REQUESTED` when approval is needed.',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      response: { 200: FollowResultSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req) => ({
      relationship: await s.social.follow(actor(req).userId, req.params.userId),
    }),
  });

  r.route({
    method: 'DELETE',
    url: '/users/:userId/follow',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.engagement),
    schema: {
      tags: ['Social'],
      operationId: 'unfollowUser',
      summary: 'Unfollow, or withdraw a pending follow request',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      response: { 204: NoContent, ...errors(401, 429) },
    },
    handler: async (req, reply) => {
      await s.social.unfollow(actor(req).userId, req.params.userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'DELETE',
    url: '/me/followers/:userId',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'removeFollower',
      summary: 'Remove one of your followers',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.social.removeFollower(actor(req).userId, req.params.userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/users/:userId/followers',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'listFollowers',
      summary: 'Followers of a user (private accounts: followers only)',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      querystring: SocialListQuerySchema,
      response: { 200: UserSummaryPageSchema, ...errors(400, 401, 403, 404) },
    },
    handler: async (req) => s.social.listFollowers(actor(req).userId, req.params.userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/users/:userId/following',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'listFollowing',
      summary: 'Accounts a user follows (private accounts: followers only)',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      querystring: SocialListQuerySchema,
      response: { 200: UserSummaryPageSchema, ...errors(400, 401, 403, 404) },
    },
    handler: async (req) => s.social.listFollowing(actor(req).userId, req.params.userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/me/follow-requests',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'listFollowRequests',
      summary: 'Pending follow requests awaiting your approval',
      security: BEARER_SECURITY,
      querystring: SocialListQuerySchema,
      response: { 200: FollowRequestPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.social.listIncomingRequests(actor(req).userId, req.query),
  });

  r.route({
    method: 'POST',
    url: '/me/follow-requests/:requestId/accept',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.engagement),
    schema: {
      tags: ['Social'],
      operationId: 'acceptFollowRequest',
      summary: 'Approve a follow request',
      security: BEARER_SECURITY,
      params: FollowRequestIdParamSchema,
      response: { 204: NoContent, ...errors(401, 404, 429) },
    },
    handler: async (req, reply) => {
      await s.social.acceptRequest(actor(req).userId, req.params.requestId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/me/follow-requests/:requestId/reject',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.engagement),
    schema: {
      tags: ['Social'],
      operationId: 'rejectFollowRequest',
      summary: 'Decline a follow request (the requester is not notified)',
      security: BEARER_SECURITY,
      params: FollowRequestIdParamSchema,
      response: { 204: NoContent, ...errors(401, 404, 429) },
    },
    handler: async (req, reply) => {
      await s.social.rejectRequest(actor(req).userId, req.params.requestId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'PUT',
    url: '/users/:userId/block',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.engagement),
    schema: {
      tags: ['Social'],
      operationId: 'blockUser',
      summary: 'Block a user',
      description:
        'Immediately severs follows and pending requests in both directions and hides each account from the other everywhere: profiles, feeds, comments, search, suggestions and notifications. Idempotent.',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      response: { 204: NoContent, ...errors(401, 404, 422, 429) },
    },
    handler: async (req, reply) => {
      await s.social.block(actor(req).userId, req.params.userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'DELETE',
    url: '/users/:userId/block',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'unblockUser',
      summary: 'Unblock a user (does not restore follows)',
      security: BEARER_SECURITY,
      params: UserIdParamSchema,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.social.unblock(actor(req).userId, req.params.userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/me/blocks',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Social'],
      operationId: 'listBlockedUsers',
      summary: 'Users you have blocked',
      security: BEARER_SECURITY,
      querystring: SocialListQuerySchema,
      response: { 200: BlockedUserPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.social.listBlocks(actor(req).userId, req.query),
  });
}
