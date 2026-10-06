import type { PlatformContext } from './platform/context';
import type { AuthContext } from './platform/http/auth-context';

declare module 'fastify' {
  interface FastifyInstance {
    platform: PlatformContext;
  }
  interface FastifyRequest {
    /** Set by the auth plugin when a valid bearer token + live session was presented. */
    auth: AuthContext | undefined;
  }
}
