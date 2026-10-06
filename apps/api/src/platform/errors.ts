import { ERROR_CATALOG, type ErrorCode } from '@runningapp/contracts';

export interface ErrorDetail {
  path: string;
  message: string;
  code?: string;
}

/**
 * The only error type handlers should throw for expected failures. Anything else is
 * treated as a bug: logged with full detail, answered with a generic INTERNAL error.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      details?: ErrorDetail[];
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? ERROR_CATALOG[code].message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
