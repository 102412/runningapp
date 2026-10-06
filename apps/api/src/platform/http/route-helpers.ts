import { z } from 'zod';
import { ErrorResponseSchema } from '@runningapp/contracts';

/**
 * OpenAPI `response` entries for error statuses, with literal keys so the handler's typed
 * reply body for the 2xx status is preserved:
 *   response: { 200: ThingSchema, ...errors(401, 404) }
 */
export function errors<const S extends readonly number[]>(
  ...statuses: S
): { [K in S[number]]: typeof ErrorResponseSchema } {
  const out: Record<number, typeof ErrorResponseSchema> = {};
  for (const s of statuses) out[s] = ErrorResponseSchema;
  return out;
}

/** Marks a route as requiring `Authorization: Bearer <accessToken>` in the OpenAPI document. */
export const BEARER_SECURITY = [{ bearerAuth: [] }];

/** Response schema for 204/202 style empty bodies. */
export const NoContent = z.undefined().describe('No content.');
