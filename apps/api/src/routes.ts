import type { FastifyInstance } from 'fastify';
import { activityRoutes } from './modules/activities/routes';
import { authRoutes } from './modules/auth/routes';
import { devRoutes } from './modules/dev/routes';
import { profileRoutes } from './modules/profiles/routes';
import { socialRoutes } from './modules/social/routes';
import { sportRoutes } from './modules/sports/routes';
import type { Services } from './services';

/** Registers every module's routes (the caller mounts this under /v1). */
export async function registerModules(app: FastifyInstance, services: Services): Promise<void> {
  await app.register(async (scope) => authRoutes(scope, services));
  await app.register(async (scope) => profileRoutes(scope, services));
  await app.register(async (scope) => socialRoutes(scope, services));
  await app.register(async (scope) => sportRoutes(scope, services));
  await app.register(async (scope) => activityRoutes(scope, services));
  if (services.platform.config.DEV_ENDPOINTS_ENABLED) {
    await app.register(async (scope) => devRoutes(scope, services));
  }
}
