import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BookmarkStateSchema,
  CommentIdParamSchema,
  CommentListQuerySchema,
  CommentPageSchema,
  CommentReactionStateSchema,
  CommentSchema,
  CreateCommentRequestSchema,
  PageQuerySchema,
  PostIdParamSchema,
  PostPageSchema,
  ReactRequestSchema,
  ReactionPageSchema,
  ReactionStateSchema,
  ShareRequestSchema,
  ShareResultSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function engagementRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const engagement = rateLimitConfig(RATE_LIMITS.engagement);

  r.route({
    method: 'PUT',
    url: '/posts/:id/reaction',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'reactToPost',
      summary: 'React to a post (idempotent; sending another type changes your reaction)',
      description:
        'One reaction per user per post. Counts are always consistent: repeated or concurrent calls never double-count.',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      body: ReactRequestSchema,
      response: { 200: ReactionStateSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req) =>
      s.engagement.react(actor(req).userId, req.params.id, req.body.type, req.body.context),
  });

  r.route({
    method: 'DELETE',
    url: '/posts/:id/reaction',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'unreactToPost',
      summary: 'Remove your reaction (idempotent)',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      response: { 200: ReactionStateSchema, ...errors(401, 429) },
    },
    handler: async (req) => s.engagement.unreact(actor(req).userId, req.params.id),
  });

  r.route({
    method: 'GET',
    url: '/posts/:id/reactions',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Engagement'],
      operationId: 'listPostReactions',
      summary: 'Who reacted (excludes people you have blocked or who blocked you)',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      querystring: PageQuerySchema,
      response: { 200: ReactionPageSchema, ...errors(400, 401, 404) },
    },
    handler: async (req) => s.engagement.listReactions(actor(req).userId, req.params.id, req.query),
  });

  r.route({
    method: 'PUT',
    url: '/posts/:id/bookmark',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'bookmarkPost',
      summary: 'Save a post (private to you)',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      response: { 200: BookmarkStateSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) => {
      await s.engagement.bookmark(actor(req).userId, req.params.id);
      return { bookmarked: true };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/posts/:id/bookmark',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'unbookmarkPost',
      summary: 'Remove a saved post (idempotent)',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      response: { 200: BookmarkStateSchema, ...errors(401, 429) },
    },
    handler: async (req) => {
      await s.engagement.unbookmark(actor(req).userId, req.params.id);
      return { bookmarked: false };
    },
  });

  r.route({
    method: 'GET',
    url: '/me/bookmarks',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Engagement'],
      operationId: 'listBookmarks',
      summary:
        'Your saved posts, most recently saved first (posts you can no longer see are omitted)',
      security: BEARER_SECURITY,
      querystring: PageQuerySchema,
      response: { 200: PostPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.engagement.listBookmarks(actor(req).userId, req.query),
  });

  r.route({
    method: 'POST',
    url: '/posts/:id/shares',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'recordShare',
      summary: 'Record that you shared a post (copy link, system share sheet...)',
      description:
        'Sharing itself happens on the device; this records the event and updates the count.',
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      body: ShareRequestSchema,
      response: { 201: ShareResultSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req, reply) =>
      reply
        .status(201)
        .send(
          await s.engagement.share(
            actor(req).userId,
            req.params.id,
            req.body.channel,
            req.body.context,
          ),
        ),
  });

  // ---- comments ------------------------------------------------------------------------------------

  r.route({
    method: 'GET',
    url: '/posts/:id/comments',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Engagement'],
      operationId: 'listComments',
      summary: 'Top-level comments on a post (replies via /comments/{id}/replies)',
      description: 'Comments by blocked users, deleted and moderated comments are never returned.',
      security: [{}, ...BEARER_SECURITY],
      params: PostIdParamSchema,
      querystring: CommentListQuerySchema,
      response: { 200: CommentPageSchema, ...errors(400, 401, 404, 429) },
    },
    handler: async (req) =>
      s.engagement.listComments(req.auth?.userId ?? null, req.params.id, req.query),
  });

  r.route({
    method: 'POST',
    url: '/posts/:id/comments',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Engagement'],
      operationId: 'createComment',
      summary: 'Comment on a post, or reply to a comment',
      description:
        "Respects the post's comment permission (`COMMENTS_RESTRICTED`). Replying to a reply attaches to the thread root. Send an `Idempotency-Key` header to make retries safe.",
      security: BEARER_SECURITY,
      params: PostIdParamSchema,
      body: CreateCommentRequestSchema,
      response: { 201: CommentSchema, ...errors(401, 403, 404, 409, 422, 429) },
    },
    handler: async (req, reply) =>
      s.idempotency.handle(req, reply, actor(req).userId, async () => ({
        status: 201,
        body: await s.engagement.createComment(actor(req).userId, req.params.id, req.body),
      })),
  });

  r.route({
    method: 'GET',
    url: '/comments/:commentId/replies',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Engagement'],
      operationId: 'listReplies',
      summary: 'Replies to a top-level comment, oldest first',
      security: [{}, ...BEARER_SECURITY],
      params: CommentIdParamSchema,
      querystring: PageQuerySchema,
      response: { 200: CommentPageSchema, ...errors(400, 401, 404, 429) },
    },
    handler: async (req) =>
      s.engagement.listReplies(req.auth?.userId ?? null, req.params.commentId, req.query),
  });

  r.route({
    method: 'DELETE',
    url: '/comments/:commentId',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Engagement'],
      operationId: 'deleteComment',
      summary:
        'Delete a comment (and its replies). Allowed for the comment author and the post author.',
      security: BEARER_SECURITY,
      params: CommentIdParamSchema,
      response: { 204: NoContent, ...errors(401, 403, 404) },
    },
    handler: async (req, reply) => {
      await s.engagement.deleteComment(actor(req).userId, req.params.commentId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'PUT',
    url: '/comments/:commentId/reaction',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'likeComment',
      summary: 'Like a comment (idempotent)',
      security: BEARER_SECURITY,
      params: CommentIdParamSchema,
      response: { 200: CommentReactionStateSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) => s.engagement.reactToComment(actor(req).userId, req.params.commentId),
  });

  r.route({
    method: 'DELETE',
    url: '/comments/:commentId/reaction',
    onRequest: app.requireAuth,
    config: engagement,
    schema: {
      tags: ['Engagement'],
      operationId: 'unlikeComment',
      summary: 'Remove your like from a comment (idempotent)',
      security: BEARER_SECURITY,
      params: CommentIdParamSchema,
      response: { 200: CommentReactionStateSchema, ...errors(401, 429) },
    },
    handler: async (req) => s.engagement.unreactToComment(actor(req).userId, req.params.commentId),
  });
}
