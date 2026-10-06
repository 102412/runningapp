import type { PlatformContext } from './platform/context';

/**
 * Composition root. Every module's service is constructed here, in dependency order, so the
 * whole dependency graph is visible in one file. Modules never import each other's internals;
 * they receive what they need through their factory's parameters.
 */
export interface Services {
  readonly platform: PlatformContext;
}

export function createServices(platform: PlatformContext): Services {
  return { platform };
}
