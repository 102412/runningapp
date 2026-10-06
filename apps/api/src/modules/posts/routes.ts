import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AttachMediaRequestSchema,
  CreatePostRequestSchema,
  IdParamSchema,
  MyPostsQuerySchema,
  PostMediaParamSchema,
  PostPageSchema,
  PostSchema,
  UpdatePostRequestSchema,
  UserIdParamSchema,
  UserPostsQuerySchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function postRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'POST',
    url: '/posts',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Posts'],
      operationId: 'createPost',
      summary: 'Share something (the SHOW step): caption, activity, photos/videos, sponsorship',
      description:
        'At least one of caption / activityId / mediaIds is required. If attached media is still processing the post is `PENDING_MEDIA` (visible only to you) and publishes itself when every item is READY (or becomes `PUBLISH_FAILED` if one fails). Sponsored content MUST include `sponsorship`. Send an `Idempotency-Key` header to make retries safe.',
      security: BEARER_SECURITY,
      body: CreatePostRequestSchema,
      response: { 201: PostSchema, ...errors(401, 403, 404, 409, 422, 429) },
    },
    handler: async (req, reply) =>
      s.idempotency.handle(req, reply, actor(req).userId, async () => ({
        status: 201,
        body: await s.posts.create(actor(req).userId, req.body),
      })),
  });

  r.route({
    method: 'GET',
    url: '/posts/:id',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Posts'],
      operationId: 'getPost',
      summary: 'One post as seen by the caller',
      description:
        'Anonymous access works for PUBLIC posts of PUBLIC accounts (e.g. shared links). Hidden, deleted, private and blocked content all answer `POST_NOT_FOUND`.',
      security: [{}, ...BEARER_SECURITY],
      params: IdParamSchema,
      response: { 200: PostSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) => s.posts.get(req.auth?.userId ?? null, req.params.id),
  });

  r.route({
    method: 'PATCH',
    url: '/posts/:id',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Posts'],
      operationId: 'updatePost',
      summary: 'Edit caption, audience, comment permission, topics or sponsorship',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      body: UpdatePostRequestSchema,
      response: { 200: PostSchema, ...errors(401, 403, 404, 409, 422, 429) },
    },
    handler: async (req) => s.posts.update(actor(req).userId, req.params.id, req.body),
  });

  r.route({
    method: 'DELETE',
    url: '/posts/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Posts'],
      operationId: 'deletePost',
      summary: 'Delete a post (and its media). It disappears for everyone immediately.',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 204: NoContent, ...errors(401, 404) },
    },
    handler: async (req, reply) => {
      await s.posts.delete(actor(req).userId, req.params.id);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/posts/:id/publish',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Posts'],
      operationId: 'publishPost',
      summary: 'Publish a DRAFT or retry a PUBLISH_FAILED post',
      description:
        'Idempotent. Fails with `MEDIA_REJECTED` while a failed/rejected media item is still attached: detach it first.',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 200: PostSchema, ...errors(401, 403, 404, 422, 429) },
    },
    handler: async (req) => s.posts.publish(actor(req).userId, req.params.id),
  });

  r.route({
    method: 'POST',
    url: '/posts/:id/media',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Posts'],
      operationId: 'attachPostMedia',
      summary: 'Add media to an existing post (e.g. add a video to an activity post)',
      description:
        "The DO -> LOG -> SHOW prompt: after an activity is logged, upload a video and attach it to the activity's post. Items still processing stay hidden from other people until READY; the post itself stays published.",
      security: BEARER_SECURITY,
      params: IdParamSchema,
      body: AttachMediaRequestSchema,
      response: { 200: PostSchema, ...errors(401, 403, 404, 409, 422, 429) },
    },
    handler: async (req) =>
      s.posts.attachMedia(actor(req).userId, req.params.id, req.body.mediaIds),
  });

  r.route({
    method: 'DELETE',
    url: '/posts/:id/media/:mediaId',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Posts'],
      operationId: 'detachPostMedia',
      summary: 'Remove one media item from a post (it stays in your media library)',
      security: BEARER_SECURITY,
      params: PostMediaParamSchema,
      response: { 200: PostSchema, ...errors(401, 404, 422) },
    },
    handler: async (req) =>
      s.posts.detachMedia(actor(req).userId, req.params.id, req.params.mediaId),
  });

  r.route({
    method: 'GET',
    url: '/me/posts',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Posts'],
      operationId: 'listMyPosts',
      summary: 'Your own posts in every state (drafts, pending media, failed, moderated)',
      security: BEARER_SECURITY,
      querystring: MyPostsQuerySchema,
      response: { 200: PostPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.posts.listOwn(actor(req).userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/users/:userId/posts',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Posts'],
      operationId: 'listUserPosts',
      summary: "A user's published posts the caller may see (profile grid), newest first",
      description:
        'Private accounts answer `ACCOUNT_PRIVATE` to non-followers. Blocked users answer `USER_NOT_FOUND`.',
      security: [{}, ...BEARER_SECURITY],
      params: UserIdParamSchema,
      querystring: UserPostsQuerySchema,
      response: { 200: PostPageSchema, ...errors(400, 401, 403, 404, 429) },
    },
    handler: async (req) =>
      s.posts.listByAuthor(req.auth?.userId ?? null, req.params.userId, req.query),
  });
}
