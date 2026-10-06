import { z } from 'zod';
import { FeedSurface } from './enums';

export const IdSchema = z.uuid().meta({ id: 'Id', description: 'UUID (v7, time-ordered).' });
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 instant with timezone, always UTC ("Z") on output. */
export const IsoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .meta({ id: 'IsoDateTime', description: 'ISO-8601 timestamp.' });

export const IsoDateSchema = z.iso
  .date()
  .meta({ id: 'IsoDate', description: 'Calendar date, YYYY-MM-DD.' });

export const MAX_PAGE_LIMIT = 50;
export const DEFAULT_PAGE_LIMIT = 20;

/** Query parameters shared by every cursor-paginated endpoint. */
export const PageQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`Page size, 1..${MAX_PAGE_LIMIT}.`),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("Opaque cursor from the previous page's `nextCursor`. Never construct one yourself."),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Wraps an item schema in the standard paginated envelope. */
export function paginated<T extends z.ZodType>(item: T, id?: string) {
  const schema = z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` to fetch the next page; null when there are no more items.'),
  });
  return id ? schema.meta({ id }) : schema;
}

export const IdParamSchema = z.object({ id: IdSchema });

export const EmptyObjectSchema = z.object({}).strict();

/** Optional attribution for engagement actions so ranking can learn what surfaced a post. */
export const EventContextSchema = z
  .object({
    feedRequestId: IdSchema.optional().describe(
      '`requestId` from the feed response that surfaced the post.',
    ),
    surface: FeedSurface.schema.optional(),
    position: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Zero-based position in the feed.'),
  })
  .meta({ id: 'EventContext' });
export type EventContext = z.infer<typeof EventContextSchema>;

/**
 * Boolean for query strings. Do NOT use z.coerce.boolean(): it maps the string "false" to true.
 * Accepts exactly "true" | "false".
 */
export const QueryBooleanSchema = z.enum(['true', 'false']).transform((v) => v === 'true');
