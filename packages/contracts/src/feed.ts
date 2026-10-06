import { z } from 'zod';
import { FeedItemReason } from './enums';
import { IdSchema, PageQuerySchema } from './common';
import { PostSchema } from './posts';

/** Same `limit` / `cursor` query as every other listing. */
export const FeedQuerySchema = PageQuerySchema;
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

export const FeedItemSchema = z
  .object({
    post: PostSchema,
    reason: FeedItemReason.schema.describe(
      'Why this item is here. Show it as a hint ("Because you follow...") or ignore it.',
    ),
    position: z
      .number()
      .int()
      .min(0)
      .describe(
        'Zero-based index within THIS page. Echo it (with the page `requestId`) in events and engagement `context`.',
      ),
  })
  .meta({ id: 'FeedItem' });
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const FeedPageSchema = z
  .object({
    requestId: IdSchema.describe(
      'Identifies this served page. Send it back as `feedRequestId` in events and engagement context.',
    ),
    algorithmVersion: z.string().describe('e.g. "chrono-v1", "ranked-v1", "explore-v1".'),
    items: z.array(FeedItemSchema),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        'Pass as `cursor` for the next page; null at the end. A page can hold fewer than `limit` items ' +
          '(content may have become invisible since the feed was built). On `FEED_EXPIRED` (410) refetch without a cursor.',
      ),
  })
  .meta({ id: 'FeedPage' });
export type FeedPage = z.infer<typeof FeedPageSchema>;
