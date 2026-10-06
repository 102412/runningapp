import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CreateExportRequestSchema,
  DataExportListSchema,
  DataExportSchema,
  ExportIdParamSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function exportRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'POST',
    url: '/me/exports',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.authStrict),
    schema: {
      tags: ['Me'],
      operationId: 'requestDataExport',
      summary: 'Request a download of all your data',
      description:
        'Requires your password. The file is built in the background (poll `GET /me/exports/{id}`), ' +
        'stays available for 7 days, and one export can be requested per day. ' +
        'If an export is already being built it is returned instead of starting another.',
      security: BEARER_SECURITY,
      body: CreateExportRequestSchema,
      response: { 202: DataExportSchema, ...errors(401, 422, 429) },
    },
    handler: async (req, reply) =>
      reply.status(202).send(await s.dataExports.request(actor(req).userId, req.body.password)),
  });

  r.route({
    method: 'GET',
    url: '/me/exports',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'listDataExports',
      summary: 'Your recent data exports',
      security: BEARER_SECURITY,
      response: { 200: DataExportListSchema, ...errors(401) },
    },
    handler: async (req) => ({ items: await s.dataExports.list(actor(req).userId) }),
  });

  r.route({
    method: 'GET',
    url: '/me/exports/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'getDataExport',
      summary: 'Status of an export; a fresh short-lived download link once READY',
      security: BEARER_SECURITY,
      params: ExportIdParamSchema,
      response: { 200: DataExportSchema, ...errors(401, 404) },
    },
    handler: async (req) => s.dataExports.get(actor(req).userId, req.params.id),
  });
}
