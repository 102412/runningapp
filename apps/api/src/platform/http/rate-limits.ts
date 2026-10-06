import type { FastifyRequest } from 'fastify';

/**
 * Named per-route rate-limit profiles. The global per-IP limiter protects the process;
 * these protect specific abuse surfaces (credential stuffing, spam, scraping).
 * `keyBy: 'user'` falls back to IP for anonymous callers.
 */
export interface RateLimitProfile {
  max: number;
  timeWindow: string;
  keyBy: 'ip' | 'user';
}

export const RATE_LIMITS = {
  /** Credential endpoints: per IP. Per-account throttling is layered on in the auth service. */
  authStrict: { max: 10, timeWindow: '1 minute', keyBy: 'ip' },
  authSignup: { max: 5, timeWindow: '1 minute', keyBy: 'ip' },
  write: { max: 60, timeWindow: '1 minute', keyBy: 'user' },
  engagement: { max: 120, timeWindow: '1 minute', keyBy: 'user' },
  upload: { max: 30, timeWindow: '1 minute', keyBy: 'user' },
  report: { max: 10, timeWindow: '1 minute', keyBy: 'user' },
  search: { max: 60, timeWindow: '1 minute', keyBy: 'user' },
  events: { max: 60, timeWindow: '1 minute', keyBy: 'user' },
} as const satisfies Record<string, RateLimitProfile>;

export function rateLimitConfig(profile: RateLimitProfile): {
  rateLimit: {
    max: number;
    timeWindow: string;
    keyGenerator: (req: FastifyRequest) => string;
  };
} {
  return {
    rateLimit: {
      max: profile.max,
      timeWindow: profile.timeWindow,
      keyGenerator: (req) =>
        profile.keyBy === 'user' && req.auth ? `u:${req.auth.userId}` : `ip:${req.ip}`,
    },
  };
}
