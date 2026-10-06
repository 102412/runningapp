import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BrandPartnershipPageSchema,
  BrandPartnershipSchema,
  CreateBrandPartnershipRequestSchema,
  CreatorProfileSchema,
  IdParamSchema,
  MyCreatorSchema,
  PageQuerySchema,
  UpsertCreatorProfileRequestSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function creatorRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/me/creator',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Creators'],
      operationId: 'getMyCreatorProfile',
      summary: 'Your creator/professional profile, if you have one',
      security: BEARER_SECURITY,
      response: { 200: MyCreatorSchema, ...errors(401) },
    },
    handler: async (req) => ({ creator: await s.creators.get(actor(req).userId) }),
  });

  r.route({
    method: 'PUT',
    url: '/me/creator',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Creators'],
      operationId: 'upsertCreatorProfile',
      summary: 'Become (or update) a creator: athlete, coach, brand, club...',
      description:
        'Verification cannot be self-granted: use POST /me/creator/verification-request and staff decide.',
      security: BEARER_SECURITY,
      body: UpsertCreatorProfileRequestSchema,
      response: { 200: CreatorProfileSchema, ...errors(401, 422, 429) },
    },
    handler: async (req) => s.creators.upsert(actor(req).userId, req.body),
  });

  r.route({
    method: 'DELETE',
    url: '/me/creator',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Creators'],
      operationId: 'deleteCreatorProfile',
      summary: 'Remove your creator profile',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.creators.remove(actor(req).userId);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'POST',
    url: '/me/creator/verification-request',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Creators'],
      operationId: 'requestCreatorVerification',
      summary: 'Ask staff to verify your creator account',
      security: BEARER_SECURITY,
      response: { 200: CreatorProfileSchema, ...errors(401, 409, 429) },
    },
    handler: async (req) => s.creators.requestVerification(actor(req).userId),
  });

  r.route({
    method: 'GET',
    url: '/me/creator/partnerships',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Creators'],
      operationId: 'listBrandPartnerships',
      summary: 'Your brand partnerships (reference them from sponsored posts)',
      security: BEARER_SECURITY,
      querystring: PageQuerySchema,
      response: { 200: BrandPartnershipPageSchema, ...errors(400, 401) },
    },
    handler: async (req) => s.creators.listPartnerships(actor(req).userId, req.query),
  });

  r.route({
    method: 'POST',
    url: '/me/creator/partnerships',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Creators'],
      operationId: 'createBrandPartnership',
      summary: 'Record a brand partnership',
      security: BEARER_SECURITY,
      body: CreateBrandPartnershipRequestSchema,
      response: { 201: BrandPartnershipSchema, ...errors(401, 409, 422, 429) },
    },
    handler: async (req, reply) =>
      reply.status(201).send(await s.creators.createPartnership(actor(req).userId, req.body)),
  });

  r.route({
    method: 'DELETE',
    url: '/me/creator/partnerships/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Creators'],
      operationId: 'deleteBrandPartnership',
      summary: 'Delete a brand partnership (existing disclosures keep their brand name)',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.creators.deletePartnership(actor(req).userId, req.params.id);
      return reply.status(204).send();
    },
  });
}
