import { z } from 'zod';

/**
 * Canonical error catalog. The API throws these codes; clients branch on `error.code`
 * (never on `message`, which is human text and may change).
 *
 * Privacy rule: when a resource exists but the viewer is not allowed to know it exists
 * (blocked, private, hidden), the API answers with the *_NOT_FOUND code, never 403.
 */
export const ERROR_CATALOG = {
  // 400
  BAD_REQUEST: { status: 400, message: 'The request was malformed.' },
  MALFORMED_JSON: { status: 400, message: 'The request body is not valid JSON.' },
  INVALID_CURSOR: { status: 400, message: 'The pagination cursor is invalid or expired.' },
  // 401
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required.' },
  TOKEN_INVALID: { status: 401, message: 'The access token is invalid.' },
  TOKEN_EXPIRED: { status: 401, message: 'The access token has expired. Refresh it.' },
  SESSION_REVOKED: { status: 401, message: 'This session is no longer active.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Email or password is incorrect.' },
  REFRESH_TOKEN_INVALID: { status: 401, message: 'The refresh token is invalid or expired.' },
  REFRESH_TOKEN_REUSED: {
    status: 401,
    message: 'The refresh token was already used. The session has been revoked; sign in again.',
  },
  // 403
  FORBIDDEN: { status: 403, message: 'You are not allowed to do that.' },
  INSUFFICIENT_ROLE: { status: 403, message: 'Your role does not permit this action.' },
  ACCOUNT_SUSPENDED: { status: 403, message: 'This account is suspended.' },
  ACCOUNT_PENDING_DELETION: { status: 403, message: 'This account is scheduled for deletion.' },
  EMAIL_NOT_VERIFIED: { status: 403, message: 'Verify your email address to do that.' },
  ACCOUNT_PRIVATE: { status: 403, message: 'This account is private.' },
  COMMENTS_RESTRICTED: { status: 403, message: 'Comments are restricted on this post.' },
  PUBLIC_ACCOUNT_NOT_ALLOWED: {
    status: 403,
    message: 'Public accounts are not available for your age.',
  },
  UNDER_MINIMUM_AGE: { status: 403, message: 'You do not meet the minimum age to sign up.' },
  // 404
  NOT_FOUND: { status: 404, message: 'Resource not found.' },
  USER_NOT_FOUND: { status: 404, message: 'User not found.' },
  POST_NOT_FOUND: { status: 404, message: 'Post not found.' },
  ACTIVITY_NOT_FOUND: { status: 404, message: 'Activity not found.' },
  COMMENT_NOT_FOUND: { status: 404, message: 'Comment not found.' },
  MEDIA_NOT_FOUND: { status: 404, message: 'Media not found.' },
  NOTIFICATION_NOT_FOUND: { status: 404, message: 'Notification not found.' },
  FOLLOW_REQUEST_NOT_FOUND: { status: 404, message: 'Follow request not found.' },
  REPORT_NOT_FOUND: { status: 404, message: 'Report not found.' },
  SESSION_NOT_FOUND: { status: 404, message: 'Session not found.' },
  TOPIC_NOT_FOUND: { status: 404, message: 'Topic not found.' },
  SPORT_NOT_FOUND: { status: 404, message: 'Sport not found.' },
  // 409
  EMAIL_TAKEN: { status: 409, message: 'An account with this email already exists.' },
  USERNAME_TAKEN: { status: 409, message: 'This username is taken.' },
  ALREADY_REPORTED: { status: 409, message: 'You already reported this.' },
  INVALID_STATE: { status: 409, message: 'The resource is not in a state that allows this.' },
  MEDIA_ALREADY_ATTACHED: { status: 409, message: 'This media is already attached to a post.' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    message: 'This Idempotency-Key was used with a different request.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    message: 'A request with this Idempotency-Key is still being processed.',
  },
  USERNAME_CHANGE_COOLDOWN: {
    status: 409,
    message: 'You changed your username recently. Try again later.',
  },
  // 410
  TOKEN_CONSUMED_OR_EXPIRED: { status: 410, message: 'This link has expired or was already used.' },
  // 413 / 415
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request body is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported content type.' },
  // 422
  VALIDATION_FAILED: { status: 422, message: 'The request failed validation.' },
  METRIC_NOT_SUPPORTED_FOR_SPORT: {
    status: 422,
    message: 'A provided metric is not supported for this sport.',
  },
  CONTENT_REJECTED: { status: 422, message: 'This content was not accepted.' },
  EMPTY_POST: { status: 422, message: 'A post needs a caption, an activity or media.' },
  SELF_ACTION_NOT_ALLOWED: { status: 422, message: 'You cannot do that to yourself.' },
  MEDIA_NOT_READY: { status: 422, message: 'The media is not ready.' },
  MEDIA_REJECTED: { status: 422, message: 'The media was rejected and cannot be used.' },
  UPLOAD_INCOMPLETE: { status: 422, message: 'The uploaded file is missing or the wrong size.' },
  UNSUPPORTED_FILE: { status: 422, message: 'The file type is not supported.' },
  PASSWORD_TOO_WEAK: { status: 422, message: 'The password does not meet requirements.' },
  PASSWORD_INCORRECT: { status: 422, message: 'The current password is incorrect.' },
  // 429
  RATE_LIMITED: { status: 429, message: 'Too many requests. Slow down.' },
  // 5xx
  INTERNAL: { status: 500, message: 'Something went wrong on our side.' },
  NOT_IMPLEMENTED: { status: 501, message: 'This is not implemented.' },
  INTEGRATION_NOT_CONFIGURED: {
    status: 501,
    message: 'This integration is not configured on this server.',
  },
  SERVICE_UNAVAILABLE: { status: 503, message: 'The service is temporarily unavailable.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

export const ErrorDetailSchema = z
  .object({
    path: z
      .string()
      .describe('Dotted path to the offending field, e.g. "caption" or "metrics.avgHeartRateBpm".'),
    message: z.string(),
    code: z.string().optional().describe('Machine-readable validation code when available.'),
  })
  .meta({ id: 'ErrorDetail' });

/** Every non-2xx response from the API has exactly this shape. */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      requestId: z.string().describe('Echo of the X-Request-Id header; quote it in bug reports.'),
      details: z.array(ErrorDetailSchema).optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
