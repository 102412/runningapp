import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  IdParamSchema,
  MediaLimitsSchema,
  MediaViewSchema,
  UploadInitRequestSchema,
  UploadInitResponseSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import { AppError } from '../../platform/errors';
import { LocalStorage, StorageSignatureError } from '../../platform/storage/local';
import type { Services } from '../../services';

export async function mediaRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/media/limits',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Media'],
      operationId: 'getMediaLimits',
      summary: 'Upload limits and accepted formats (validate client-side before uploading)',
      security: BEARER_SECURITY,
      response: { 200: MediaLimitsSchema, ...errors(401) },
    },
    handler: async () => s.media.limits(),
  });

  r.route({
    method: 'POST',
    url: '/media/uploads',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.upload),
    schema: {
      tags: ['Media'],
      operationId: 'initMediaUpload',
      summary: 'Start an upload and get a presigned URL (step 1 of 3)',
      description:
        'Upload flow: (1) POST here, (2) PUT the raw bytes to `upload.url` with EXACTLY `upload.headers` (the file goes straight to object storage, not through this API), (3) POST /media/{id}/complete. Then poll GET /media/{id} until `status` is READY (or FAILED/REJECTED). Attach READY media to posts via POST /posts.',
      security: BEARER_SECURITY,
      body: UploadInitRequestSchema,
      response: { 201: UploadInitResponseSchema, ...errors(401, 413, 422, 429) },
    },
    handler: async (req, reply) =>
      reply.status(201).send(await s.media.initUpload(actor(req).userId, req.body)),
  });

  r.route({
    method: 'POST',
    url: '/media/:id/complete',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.upload),
    schema: {
      tags: ['Media'],
      operationId: 'completeMediaUpload',
      summary: 'Confirm the file was uploaded and start processing (step 3 of 3)',
      description:
        'Idempotent. Fails with UPLOAD_INCOMPLETE if the object is missing or its size differs from what was declared.',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 200: MediaViewSchema, ...errors(401, 404, 422, 429) },
    },
    handler: async (req) => s.media.complete(actor(req).userId, req.params.id),
  });

  r.route({
    method: 'GET',
    url: '/media/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Media'],
      operationId: 'getMedia',
      summary: 'Status and URLs of your own media (poll while PROCESSING)',
      description:
        'Owner only. Other people see media only as part of posts they are allowed to see.',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 200: MediaViewSchema, ...errors(401, 404) },
    },
    handler: async (req) => s.media.getOwned(actor(req).userId, req.params.id),
  });

  r.route({
    method: 'POST',
    url: '/media/:id/retry',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.upload),
    schema: {
      tags: ['Media'],
      operationId: 'retryMediaProcessing',
      summary: 'Retry processing of media that FAILED with PROCESSING_ERROR',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 200: MediaViewSchema, ...errors(401, 404, 409, 429) },
    },
    handler: async (req) => s.media.retry(actor(req).userId, req.params.id),
  });

  r.route({
    method: 'DELETE',
    url: '/media/:id',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Media'],
      operationId: 'deleteMedia',
      summary: 'Delete your media (refused while attached to a post)',
      security: BEARER_SECURITY,
      params: IdParamSchema,
      response: { 204: NoContent, ...errors(401, 404, 409) },
    },
    handler: async (req, reply) => {
      await s.media.delete(actor(req).userId, req.params.id);
      return reply.status(204).send();
    },
  });
}

// ---- local-driver storage endpoints --------------------------------------------------------------

const SignedQuery = z.object({
  key: z.string().min(3).max(300),
  exp: z.coerce.number().int(),
  sig: z.string().min(20).max(100),
});
const ReadQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(20).max(100) });

/**
 * Serves the `local` storage driver: a signed upload sink and signed, Range-capable file reads.
 * These stand in for S3 presigned URLs during development. Registered only when
 * STORAGE_DRIVER=local (which production config refuses).
 */
export async function localStorageRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const storage = s.storage;
  if (!(storage instanceof LocalStorage)) return;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Raw streaming body for any content type; size is enforced byte-by-byte in writeStream().
  app.addContentTypeParser('*', (_req, payload, done) => {
    done(null, payload);
  });

  r.route({
    method: 'PUT',
    url: '/storage/upload',
    config: rateLimitConfig(RATE_LIMITS.upload),
    schema: {
      tags: ['Dev'],
      operationId: 'devLocalUpload',
      summary: 'DEV ONLY (local storage driver): signed upload target',
      querystring: SignedQuery,
      response: { 200: NoContent, ...errors(403, 429) },
    },
    handler: async (req, reply) => {
      const lengthHeader = req.headers['content-length'];
      const contentLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
      try {
        storage.verifyUpload(req.query, {
          contentType: req.headers['content-type'],
          contentLength,
        });
        await storage.writeStream(req.query.key, req.body as Readable, contentLength as number);
      } catch (err) {
        if (err instanceof StorageSignatureError)
          throw new AppError('FORBIDDEN', { message: 'Upload rejected.' });
        throw err;
      }
      return reply.status(200).send();
    },
  });

  r.route({
    method: 'GET',
    url: '/storage/files/*',
    config: rateLimitConfig({ max: 600, timeWindow: '1 minute', keyBy: 'ip' }),
    schema: {
      tags: ['Dev'],
      operationId: 'devLocalFile',
      summary: 'DEV ONLY (local storage driver): signed file download',
      params: z.object({ '*': z.string() }),
      querystring: ReadQuery,
      response: { 200: z.unknown(), 206: z.unknown(), ...errors(403, 404, 416, 429) },
    },
    handler: async (req, reply) => {
      const key = req.params['*'];
      try {
        storage.verifyRead({ key, exp: req.query.exp, sig: req.query.sig });
      } catch (err) {
        if (err instanceof StorageSignatureError)
          throw new AppError('FORBIDDEN', { message: 'Invalid or expired link.' });
        throw err;
      }
      if (key.endsWith('/original')) throw new AppError('NOT_FOUND'); // originals are never served
      const info = await storage.head(key);
      if (!info) throw new AppError('NOT_FOUND');

      const remaining = Math.max(
        0,
        req.query.exp - Math.floor(s.platform.clock.now().getTime() / 1000),
      );
      void reply.header('cache-control', `private, max-age=${remaining}, immutable`);
      void reply.header('accept-ranges', 'bytes');
      void reply.header('content-disposition', 'inline');

      const range = parseRange(req.headers.range, info.sizeBytes);
      if (range === 'INVALID') {
        void reply.header('content-range', `bytes */${info.sizeBytes}`);
        return reply.status(416).send({
          error: { code: 'BAD_REQUEST', message: 'Range not satisfiable.', requestId: req.id },
        });
      }
      const file = await storage.openForRead(key, range ?? undefined);
      void reply.header('content-type', file.contentType);
      if (range) {
        void reply.header('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
        void reply.header('content-length', String(range.end - range.start + 1));
        return reply.status(206).send(file.stream);
      }
      void reply.header('content-length', String(file.size));
      return reply.status(200).send(file.stream);
    },
  });
}

/** Single-range `bytes=a-b` / `bytes=a-` / `bytes=-n`. Multi-range is not supported (ignored). */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'INVALID' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return 'INVALID';
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'INVALID';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size)
    return 'INVALID';
  return { start, end };
}
