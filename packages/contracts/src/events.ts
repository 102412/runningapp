import { z } from 'zod';
import { ClientEventType, FeedSurface } from './enums';
import { IdSchema, IsoDateTimeSchema } from './common';

export const MAX_EVENTS_PER_BATCH = 100;

/** Event types that must reference a post. */
const NEEDS_POST: ReadonlySet<string> = new Set([
  'IMPRESSION',
  'VIDEO_START',
  'VIDEO_COMPLETE',
  'WATCH_TIME',
  'SKIP',
  'ACTIVITY_OPEN',
  'MEDIA_EXPAND',
  'NOT_INTERESTED',
]);

/**
 * One behavioural observation made by the client. Likes, comments, shares, bookmarks and
 * follows are NOT sent here: the server records those itself when you call the endpoint.
 */
export const ClientEventSchema = z
  .object({
    eventId: IdSchema.describe(
      'Generate a UUID per event. Re-sending a batch is safe: events with a known id are ignored.',
    ),
    type: ClientEventType.schema,
    postId: IdSchema.optional().describe(
      'Required for IMPRESSION, VIDEO_START, VIDEO_COMPLETE, WATCH_TIME, SKIP, ACTIVITY_OPEN, MEDIA_EXPAND, NOT_INTERESTED.',
    ),
    subjectUserId: IdSchema.optional().describe('Required for PROFILE_OPEN.'),
    topic: z.string().trim().min(1).max(50).optional().describe('Required for TOPIC_INTERACTION.'),
    surface: FeedSurface.schema.optional(),
    feedRequestId: IdSchema.optional().describe(
      '`requestId` of the feed page that showed the post.',
    ),
    position: z.number().int().min(0).max(10_000).optional(),
    valueMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .optional()
      .describe('Required for WATCH_TIME: milliseconds watched.'),
    clientTs: IsoDateTimeSchema.optional().describe('When it happened on the device.'),
  })
  .strict()
  .superRefine((e, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (NEEDS_POST.has(e.type))
      need(e.postId !== undefined, 'postId', `postId is required for ${e.type}.`);
    if (e.type === 'PROFILE_OPEN')
      need(
        e.subjectUserId !== undefined,
        'subjectUserId',
        'subjectUserId is required for PROFILE_OPEN.',
      );
    if (e.type === 'TOPIC_INTERACTION')
      need(e.topic !== undefined, 'topic', 'topic is required for TOPIC_INTERACTION.');
    if (e.type === 'WATCH_TIME')
      need(e.valueMs !== undefined, 'valueMs', 'valueMs is required for WATCH_TIME.');
  });
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const EventBatchRequestSchema = z
  .object({ events: z.array(ClientEventSchema).min(1).max(MAX_EVENTS_PER_BATCH) })
  .strict();
export type EventBatchRequest = z.infer<typeof EventBatchRequestSchema>;

export const EventBatchResultSchema = z
  .object({
    accepted: z
      .number()
      .int()
      .describe(
        'Events stored. Includes events intentionally discarded because the user turned personalization off.',
      ),
    duplicates: z
      .number()
      .int()
      .describe('Events skipped because their `eventId` was already received.'),
    rejected: z
      .array(
        z.object({
          eventId: IdSchema,
          code: z.enum(['POST_NOT_FOUND', 'USER_NOT_FOUND']),
        }),
      )
      .describe('Events that referenced content the user cannot see. Do not retry these.'),
  })
  .meta({ id: 'EventBatchResult' });
export type EventBatchResult = z.infer<typeof EventBatchResultSchema>;
