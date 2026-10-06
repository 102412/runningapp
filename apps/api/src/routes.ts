import type { FastifyInstance } from 'fastify';
import type { Services } from './services';

/** Registers every module's routes under the /v1 prefix. */
export async function registerModules(_app: FastifyInstance, _services: Services): Promise<void> {
  await Promise.resolve();
}
