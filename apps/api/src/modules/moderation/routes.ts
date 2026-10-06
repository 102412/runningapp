import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AdminReportDetailSchema,
  AdminReportPageSchema,
  AdminReportQuerySchema,
  CreateReportRequestSchema,
  ModerationActionPageSchema,
  ModerationActionRequestSchema,
  ModerationActionSchema,
  ModerationActionsQuerySchema,
  PageQuerySchema,
  ReportIdParamSchema,
  ReportReceiptPageSchema,
  ReportReceiptSchema,
  ResolveReportRequestSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function moderationRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const staff = (req: Parameters<typeof actor>[0]) => {
    const a = actor(req);
    return { userId: a.userId, role: a.role };
  };

  // ---- reporting (any verified user) -----------------------------------------------------------

  r.route({
    method: 'POST',
    url: '/reports',
    onRequest: app.requireVerified,
    config: rateLimitConfig(RATE_LIMITS.report),
    schema: {
      tags: ['Moderation'],
      operationId: 'createReport',
      summary: 'Report a post, comment or user',
      description:
        'You can only report what you can see (otherwise 404), not your own content, and each thing once (`ALREADY_REPORTED`). ' +
        'Reports go to a human moderation queue; you are not told the outcome.',
      security: BEARER_SECURITY,
      body: CreateReportRequestSchema,
      response: { 201: ReportReceiptSchema, ...errors(401, 403, 404, 409, 422, 429) },
    },
    handler: async (req, reply) =>
      reply.status(201).send(await s.reports.create(actor(req).userId, req.body)),
  });

  r.route({
    method: 'GET',
    url: '/me/reports',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Moderation'],
      operationId: 'listMyReports',
      summary: 'Reports you filed (status only)',
      security: BEARER_SECURITY,
      querystring: PageQuerySchema,
      response: { 200: ReportReceiptPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.reports.listMine(actor(req).userId, req.query),
  });

  // ---- staff ---------------------------------------------------------------------------------------
  const moderator = app.requireRole('MODERATOR');
  const write = rateLimitConfig(RATE_LIMITS.write);

  r.route({
    method: 'GET',
    url: '/admin/reports',
    onRequest: moderator,
    schema: {
      tags: ['Admin'],
      operationId: 'adminListReports',
      summary: 'Moderation queue, oldest first',
      description:
        'Moderators and admins. Filter by `status` (usually OPEN), `targetType`, `source` or `reason`.',
      security: BEARER_SECURITY,
      querystring: AdminReportQuerySchema,
      response: { 200: AdminReportPageSchema, ...errors(400, 401, 403) },
    },
    handler: async (req) => s.moderation.listReports(req.query),
  });

  r.route({
    method: 'GET',
    url: '/admin/reports/:id',
    onRequest: moderator,
    schema: {
      tags: ['Admin'],
      operationId: 'adminGetReport',
      summary: 'One report with the reported content and the audit trail for the target',
      security: BEARER_SECURITY,
      params: ReportIdParamSchema,
      response: { 200: AdminReportDetailSchema, ...errors(401, 403, 404) },
    },
    handler: async (req) => s.moderation.getReport(req.params.id),
  });

  r.route({
    method: 'POST',
    url: '/admin/reports/:id/resolve',
    onRequest: moderator,
    config: write,
    schema: {
      tags: ['Admin'],
      operationId: 'adminResolveReport',
      summary: 'Act on a report (hide, remove, warn, suspend) or dismiss it',
      description:
        'Writes the audit trail and notifies the affected user. Acting on content settles every other open report about it. ' +
        'You cannot act against accounts of equal or higher role. For `WARN_USER` the note is shown to the user.',
      security: BEARER_SECURITY,
      params: ReportIdParamSchema,
      body: ResolveReportRequestSchema,
      response: { 200: AdminReportDetailSchema, ...errors(401, 403, 404, 409, 422) },
    },
    handler: async (req) => s.moderation.resolveReport(staff(req), req.params.id, req.body),
  });

  r.route({
    method: 'POST',
    url: '/admin/moderation/actions',
    onRequest: moderator,
    config: write,
    schema: {
      tags: ['Admin'],
      operationId: 'adminTakeAction',
      summary: 'Take a moderation action without a report (restore, unsuspend, verify creators...)',
      description: '`SET_CREATOR_VERIFICATION` is admin-only.',
      security: BEARER_SECURITY,
      body: ModerationActionRequestSchema,
      response: { 201: ModerationActionSchema, ...errors(401, 403, 404, 409, 422) },
    },
    handler: async (req, reply) =>
      reply.status(201).send(await s.moderation.act(staff(req), req.body)),
  });

  r.route({
    method: 'GET',
    url: '/admin/moderation/actions',
    onRequest: moderator,
    schema: {
      tags: ['Admin'],
      operationId: 'adminListActions',
      summary: 'The moderation audit trail, newest first',
      description:
        'Append-only. Filter by `targetType` and/or `targetId` (a post, comment or user id).',
      security: BEARER_SECURITY,
      querystring: ModerationActionsQuerySchema,
      response: { 200: ModerationActionPageSchema, ...errors(400, 401, 403) },
    },
    handler: async (req) => s.moderation.listActions(req.query),
  });
}
