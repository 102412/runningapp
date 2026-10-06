import type { components } from './generated/schema';

export type ErrorCode = components['schemas']['ErrorCode'];
export type ErrorDetail = components['schemas']['ErrorDetail'];

/**
 * Every failed API call surfaces as one of these. Branch on `code` (stable), never on `message`
 * (human text, may change). `requestId` identifies the call in server logs: show it in bug reports.
 * Network failures (no response at all) are `NETWORK_ERROR` with status 0.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN';
  readonly status: number;
  readonly requestId: string | null;
  readonly details: ErrorDetail[];

  constructor(init: {
    code: ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN';
    message: string;
    status: number;
    requestId?: string | null;
    details?: ErrorDetail[];
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
  }

  /** Field-level validation messages keyed by path (empty unless `code` is VALIDATION_FAILED). */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.details.map((d) => [d.path, d.message]));
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** Builds an ApiError from a parsed error body (or whatever came back instead of one). */
export function toApiError(status: number, body: unknown): ApiError {
  const envelope = (
    body as { error?: Partial<components['schemas']['ErrorResponse']['error']> } | null
  )?.error;
  if (envelope && typeof envelope.code === 'string') {
    return new ApiError({
      code: envelope.code,
      message: envelope.message ?? 'Request failed.',
      status,
      requestId: envelope.requestId ?? null,
      details: envelope.details ?? [],
    });
  }
  return new ApiError({
    code: 'UNKNOWN',
    message: `Request failed with status ${status}.`,
    status,
  });
}

/** Unwraps an openapi-fetch result: returns `data` or throws an ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    if (result.response.status === 204 && result.error === undefined) return undefined as T;
    throw toApiError(result.response.status, result.error);
  }
  return result.data;
}
