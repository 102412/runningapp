import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ActivityListQuerySchema,
  ActivityPageSchema,
  ActivitySchema,
  CreateActivityRequestSchema,
  CreatePrivacyZoneRequestSchema,
  IdParamSchema,
  ImportGpxQuerySchema,
  LoggedActivitySchema,
  IntegrationListSchema,
  IntegrationProvider,
  PrivacyZoneListSchema,
  PrivacyZoneSchema,
  RouteQuerySchema,
  RouteViewSchema,
  UpdateActivityRequestSchema,
  UserIdParamSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import { AppError } from '../../platform/errors';
import type { Services } from '../../services';
import { GpxError, parseGpx } from './gpx';

const GPX_LIMIT_BYTES = 10 * 1024 * 1024;

export async function activityRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GPX arrives as raw XML. Scoped to this plugin so no other route accepts these content types.
  app.addContentTypeParser(
    ['application/gpx+xml', 'application/xml', 'text/xml'],
    { parseAs: 'string', bodyLimit: GPX_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  r.route({
    method: 'POST',
    url: '/activities',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Activities'],
      operationId: 'createActivity',
      summary: 'Log an activity (the LOG step)',
      description:
        'Metrics are all optional; supplying one the sport does not support is rejected with `METRIC_NOT_SUPPORTED_FOR_SPORT`. Units are SI (metres, seconds, m/s). When `createPost` is true (default: your `autoCreateActivityPost` setting) a feed post is created for the activity.',
      security: BEARER_SECURITY,
      body: CreateActivityRequestSchema,
      response: { 201: LoggedActivitySchema, ...errors(401, 403, 409, 422, 429) },
    },
    handler: async (req, reply) =>
      s.idempotency.handle(req, reply, actor(req).userId, async () => {
        const { activity } = await s.flows.logActivity(
          { id: actor(req).userId, emailVerified: actor(req).emailVerified },
          req.body,
        );
        return { status: 201, body: activity };
      }),
  });

  r.route({
    method: 'POST',
    url: '/activities/import/gpx',
    onRequest: app.requireAuth,
    bodyLimit: GPX_LIMIT_BYTES,
    config: rateLimitConfig(RATE_LIMITS.upload),
    schema: {
      tags: ['Activities'],
      operationId: 'importGpxActivity',
      summary: 'Import a GPX file as an activity',
      description:
        'Send the raw GPX XML as the request body with `Content-Type: application/gpx+xml` (max 10 MB). Distance, moving time, elevation, kilometre splits and heart rate are derived from the track; every point must carry a <time>. Importing the same file twice is idempotent and returns the existing activity (200).',
      security: BEARER_SECURITY,
      consumes: ['application/gpx+xml', 'application/xml', 'text/xml'],
      querystring: ImportGpxQuerySchema,
      body: z.string().min(20),
      response: {
        200: LoggedActivitySchema,
        201: LoggedActivitySchema,
        ...errors(401, 413, 415, 422, 429),
      },
    },
    handler: async (req, reply) => {
      let imported;
      try {
        imported = parseGpx(req.body);
      } catch (err) {
        if (err instanceof GpxError)
          throw new AppError('UNSUPPORTED_FILE', { message: err.message });
        throw err;
      }
      const sport = req.query.sport ?? imported.sport;
      if (!sport) {
        throw new AppError('VALIDATION_FAILED', {
          details: [
            { path: 'query.sport', message: 'The file does not declare a sport; pass ?sport=.' },
          ],
        });
      }
      const request = s.activities.fromImport(imported, {
        sport,
        title: req.query.title,
        timezone: req.query.timezone,
        visibility: req.query.visibility,
        routePrivacy: req.query.routePrivacy,
        isRace: req.query.isRace,
      });
      if (req.query.createPost !== undefined) request.createPost = req.query.createPost;
      const { activity, created } = await s.flows.logActivity(
        { id: actor(req).userId, emailVerified: actor(req).emailVerified },
        request,
        {
          source: 'FILE_IMPORT',
          externalId: imported.externalId,
          skipCapabilityCheck: true,
        },
      );
      return reply.status(created ? 201 : 200).send(activity);
    },
  });

  r.route({
    method: 'GET',
    url: '/activities/:id',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Activities'],
      operationId: 'getActivity',
      summary: 'One activity, with splits',
      description:
        'Not-visible and non-existent activities are indistinguishable (`ACTIVITY_NOT_FOUND`). Routes are privacy-filtered for everyone but the owner.',
      security: [{}, ...BEARER_SECURITY],
      params: IdParamSchema,
      response: { 200: ActivitySchema, ...errors(401, 404, 429) },
    },
    handler: async (req) =>
      s.activities.get(req.auth?.userId ?? null, req.params.id, { includeSplits: true }),
  });

  r.route({
    method: 'GET',
    url: '/activities/:id/route',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Activities'],
      operationId: 'getActivityRoute',
      summary: 'The activity route as encoded polyline segments',
      description:
        'Owners get the real route (or, with `view=PUBLIC`, a preview of exactly what others see). Everyone else gets the privacy-transformed route: ends trimmed, privacy zones removed, optionally coarsened. 404 when there is nothing to show.',
      security: [{}, ...BEARER_SECURITY],
      params: IdParamSchema,
      querystring: RouteQuerySchema,
      response: { 200: RouteViewSchema, ...errors(401, 404, 429) },
    },
    handler: async (req) =>
      s.activities.getRoute(req.auth?.userId ?? null, req.params.id, req.query.view),
  });

  r.route({
    method: 'PATCH',
    url: '/activities/:id',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Activities'],
      operationId: 'updateActivity',
      summary: 'Edit title, description, visibility, route privacy',
      description: 'Only the owner. Measurements are immutable once logged.',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      body: UpdateActivityRequestSchema,
      response: { 200: ActivitySchema, ...errors(401, 403, 404, 422, 429) },
    },
    handler: async (req) => s.flows.updateActivity(actor(req).userId, req.params.id, req.body),
  });

  r.route({
    method: 'DELETE',
    url: '/activities/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Activities'],
      operationId: 'deleteActivity',
      summary: 'Delete an activity (and its route and auto-generated feed post)',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 204: NoContent, ...errors(401, 404) },
    },
    handler: async (req, reply) => {
      await s.flows.deleteActivity(actor(req).userId, req.params.id);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/users/:userId/activities',
    onRequest: app.optionalAuth,
    config: rateLimitConfig(RATE_LIMITS.search),
    schema: {
      tags: ['Activities'],
      operationId: 'listUserActivities',
      summary: "A user's activities visible to the caller, newest first",
      security: [{}, ...BEARER_SECURITY],
      params: UserIdParamSchema,
      querystring: ActivityListQuerySchema,
      response: { 200: ActivityPageSchema, ...errors(400, 401, 429) },
    },
    handler: async (req) =>
      s.activities.list(req.auth?.userId ?? null, req.params.userId, req.query),
  });

  // ---- privacy zones -------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/me/privacy-zones',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'listPrivacyZones',
      summary: 'Your privacy zones (home, school...)',
      security: BEARER_SECURITY,
      response: { 200: PrivacyZoneListSchema, ...errors(401) },
    },
    handler: async (req) => ({ items: await s.activities.listZones(actor(req).userId) }),
  });

  r.route({
    method: 'POST',
    url: '/me/privacy-zones',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Me'],
      operationId: 'createPrivacyZone',
      summary: 'Hide everything near a place from other viewers (max 10 zones)',
      description:
        'Applies retroactively to every activity: route points within the radius are never served to anyone but you.',
      security: BEARER_SECURITY,
      body: CreatePrivacyZoneRequestSchema,
      response: { 201: PrivacyZoneSchema, ...errors(401, 422, 429) },
    },
    handler: async (req, reply) =>
      reply.status(201).send(await s.activities.createZone(actor(req).userId, req.body)),
  });

  r.route({
    method: 'DELETE',
    url: '/me/privacy-zones/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'deletePrivacyZone',
      summary: 'Remove a privacy zone',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.activities.deleteZone(actor(req).userId, req.params.id);
      return reply.status(204).send();
    },
  });

  // ---- integrations ----------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/me/integrations',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'listIntegrations',
      summary: 'Third-party activity sources and their availability',
      description:
        'No provider is configured yet: every entry has `available: false`. See HANDOFF.md.',
      security: BEARER_SECURITY,
      response: { 200: IntegrationListSchema, ...errors(401) },
    },
    handler: async (req) => ({ items: await s.integrations.list(actor(req).userId) }),
  });

  r.route({
    method: 'DELETE',
    url: '/me/integrations/:provider',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Me'],
      operationId: 'disconnectIntegration',
      summary: 'Disconnect an integration',
      security: BEARER_SECURITY,
      params: z.object({ provider: IntegrationProvider.schema }),
      response: { 204: NoContent, ...errors(401, 422) },
    },
    handler: async (req, reply) => {
      await s.integrations.disconnect(actor(req).userId, req.params.provider);
      return reply.status(204).send();
    },
  });
}
