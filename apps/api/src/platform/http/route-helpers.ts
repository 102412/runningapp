import { ErrorResponseSchema, type ErrorCode } from '@runningapp/contracts';
import { ERROR_CATALOG } from '@runningapp/contracts';
import type { ZodType } from 'zod';

/**
 * OpenAPI `response` entries for the common error statuses, so every route documents them
 * with the same schema. Usage: `response: { 200: X, ...errorResponses(401, 404) }`.
 */
export function errorResponses(...statuses: number[]): Record<number, ZodType> {
  const out: Record<number, ZodType> = {};
  for (const s of statuses) out[s] = ErrorResponseSchema;
  return out;
}

export const BEARER_SECURITY = [{ bearerAuth: [] }] as const;

export function describeErrorCodes(codes: readonly ErrorCode[]): string {
  return codes.map((c) => `\`${c}\` (${ERROR_CATALOG[c].status})`).join(', ');
}
