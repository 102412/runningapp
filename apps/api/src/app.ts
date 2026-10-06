import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { API_BASE_PATH, API_VERSION } from '@runningapp/contracts';
import { migrationsUpToDate } from './platform/db/migrate';
import { AppError } from './platform/errors';
import { installErrorHandling } from './platform/http/error-handler';
import { tidyOpenApi } from './platform/http/openapi';
import type { PlatformContext } from './platform/context';
import { safeEqual } from './platform/crypto/tokens';
import { uuidv7 } from './platform/ids';
import { authPlugin } from './modules/auth/plugin';
import { registerModules } from './routes';
import type { Services } from './services';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const BODY_LIMIT_BYTES = 1024 * 1024;

export interface BuildAppOptions {
  /** Disable Swagger registration (used by tests that don't need the spec). */
  withOpenApi?: boolean;
}

export async function buildApp(
  platform: PlatformContext,
  services: Services,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { config } = platform;

  const app = Fastify({
    loggerInstance: platform.logger,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : uuidv7();
    },
    // Trust exactly N reverse-proxy hops for X-Forwarded-For (0 = none), so clients cannot spoof IPs.
    trustProxy:
      config.TRUST_PROXY_HOPS > 0
        ? (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS
        : false,
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('platform', platform);
  app.decorateRequest('auth', undefined);
  installErrorHandling(app);

  // ---- security headers, CORS, rate limiting -----------------------------------------
  await app.register(helmet, {
    // This is a JSON API: no HTML is served, so a locked-down CSP is correct.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // media is fetched cross-origin by clients
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : !config.isProduction,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });

  if (config.RATE_LIMIT_ENABLED) {
    let redis: Redis | undefined;
    if (config.REDIS_URL) {
      const { Redis } = await import('ioredis');
      redis = new Redis(config.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 });
      redis.on('error', (err: Error) =>
        platform.logger.warn({ err }, 'redis error (rate limiting fails open)'),
      );
      app.addHook('onClose', async () => {
        redis?.disconnect();
      });
    }
    await app.register(rateLimit, {
      global: true,
      // preHandler so per-user limits can key on the authenticated principal (auth runs in onRequest).
      hook: 'preHandler',
      max: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
      timeWindow: '1 minute',
      redis,
      skipOnError: true,
      enableDraftSpec: true,
      allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
      errorResponseBuilder: (_req, context) =>
        new AppError('RATE_LIMITED', {
          headers: { 'retry-after': String(Math.max(1, Math.ceil(context.ttl / 1000))) },
        }),
    });
  }

  // ---- request lifecycle: ids, caching policy, metrics --------------------------------
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    // API responses are per-viewer and often private. Routes may override (e.g. media files).
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    platform.metrics.httpDuration.observe(
      { method: request.method, route, status_class: `${Math.floor(reply.statusCode / 100)}xx` },
      reply.elapsedTime / 1000,
    );
  });

  // ---- OpenAPI ------------------------------------------------------------------------
  if (options.withOpenApi !== false) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'RunningApp API',
          version: API_VERSION,
          description:
            'Backend for an athlete-focused social platform (DO -> LOG -> SHOW). See docs/FRONTEND_INTEGRATION.md.',
        },
        servers: [{ url: config.PUBLIC_BASE_URL }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Access token from /v1/auth/login|signup|refresh.',
            },
          },
        },
        tags: [
          { name: 'Auth' },
          { name: 'Me' },
          { name: 'Users' },
          { name: 'Social' },
          { name: 'Sports' },
          { name: 'Activities' },
          { name: 'Media' },
          { name: 'Posts' },
          { name: 'Engagement' },
          { name: 'Notifications' },
          { name: 'Feed' },
          { name: 'Events' },
          { name: 'Search' },
          { name: 'Discover' },
          { name: 'Creators' },
          { name: 'Moderation' },
          { name: 'Admin' },
          { name: 'System' },
          { name: 'Dev' },
        ],
      },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
  }

  // ---- system endpoints (unversioned) ---------------------------------------------------
  app.get('/healthz', { schema: { hide: true } }, async () => ({
    status: 'ok',
    version: API_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/readyz', { schema: { hide: true } }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { database: 'fail', migrations: 'fail' };
    try {
      await platform.pool.query('select 1');
      checks.database = 'ok';
      checks.migrations = (await migrationsUpToDate(platform.pool)) ? 'ok' : 'fail';
    } catch (err) {
      platform.logger.warn({ err }, 'readiness check failed');
    }
    const ready = Object.values(checks).every((c) => c === 'ok');
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'unavailable', checks });
  });

  app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
    const token = config.METRICS_TOKEN;
    if (token) {
      const header = request.headers.authorization ?? '';
      if (!safeEqual(header, `Bearer ${token}`)) throw new AppError('UNAUTHENTICATED');
    } else if (config.isProduction) {
      throw new AppError('NOT_FOUND'); // never expose metrics unauthenticated in production
    }
    return reply
      .header('content-type', platform.metrics.registry.contentType)
      .send(await platform.metrics.registry.metrics());
  });

  // ---- versioned API --------------------------------------------------------------------
  await app.register(authPlugin(platform, services.accessTokens));
  await app.register(
    async (v1) => {
      if (options.withOpenApi !== false) {
        v1.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
          return reply
            .header('cache-control', 'public, max-age=60')
            .send(tidyOpenApi(app.swagger()));
        });
      }
      await registerModules(v1, services);
    },
    { prefix: API_BASE_PATH },
  );

  return app;
}
