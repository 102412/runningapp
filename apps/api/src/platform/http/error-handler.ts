import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ERROR_CATALOG, type ErrorCode, type ErrorResponse } from '@runningapp/contracts';
import { AppError, isAppError, type ErrorDetail } from '../errors';

function body(
  code: ErrorCode,
  requestId: string,
  message?: string,
  details?: ErrorDetail[],
): ErrorResponse {
  return {
    error: {
      code,
      message: message ?? ERROR_CATALOG[code].message,
      requestId,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };
}

function validationContextPrefix(context: string | undefined): string {
  switch (context) {
    case 'querystring':
      return 'query.';
    case 'params':
      return 'params.';
    case 'headers':
      return 'headers.';
    default:
      return ''; // body fields are addressed bare: "caption", "metrics.avgHeartRateBpm"
  }
}

/** Translates any thrown value into the canonical error envelope. Never leaks internals. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(body('NOT_FOUND', request.id, 'Route not found.'));
  });

  app.setErrorHandler((err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (isAppError(err)) {
      if (err.headers) void reply.headers(err.headers);
      if (err.status >= 500) request.log.error({ err }, 'application error');
      return reply.status(err.status).send(body(err.code, requestId, err.message, err.details));
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const prefix = validationContextPrefix(err.validationContext);
      const details: ErrorDetail[] = err.validation.map((v) => ({
        path: `${prefix}${v.instancePath.replace(/^\//, '').replaceAll('/', '.')}`.replace(
          /\.$/,
          '',
        ),
        message: v.message ?? 'Invalid value',
        code: v.keyword,
      }));
      return reply.status(422).send(body('VALIDATION_FAILED', requestId, undefined, details));
    }

    const fastifyCode = 'code' in err ? err.code : undefined;
    switch (fastifyCode) {
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return reply.status(400).send(body('MALFORMED_JSON', requestId));
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return reply.status(413).send(body('PAYLOAD_TOO_LARGE', requestId));
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return reply.status(415).send(body('UNSUPPORTED_MEDIA_TYPE', requestId));
      case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      case 'FST_ERR_CTP_INVALID_HEADERS':
        return reply.status(400).send(body('BAD_REQUEST', requestId));
      default:
        break;
    }

    // Unknown failure: a bug (or response-serialization mismatch). Log everything, reveal nothing.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('INTERNAL', requestId));
  });
}

export { AppError };
