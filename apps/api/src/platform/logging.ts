import type { LoggerOptions } from 'pino';
import type { Config } from '../config';

/**
 * Structured JSON logging (pino, via Fastify). Request/response bodies are never logged.
 * Redaction is defence in depth: even if a future change logs an object containing
 * credentials, these paths are censored.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'refreshToken',
  'accessToken',
  'token',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.secret',
  '*.passwordHash',
  '*.tokenHash',
];

export function buildLoggerOptions(config: Config): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      req(req: { method?: string; url?: string; id?: string; ip?: string }) {
        // Drop the query string: signed media URLs carry signatures there.
        const url = req.url?.split('?')[0];
        return { method: req.method, url, id: req.id, remoteAddress: req.ip };
      },
    },
    ...(config.LOG_PRETTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  };
}
