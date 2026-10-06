import { z } from 'zod';
import { ReactionType, ShareChannel } from './enums';
import {
  EventContextSchema,
  IdSchema,
  IsoDateTimeSchema,
  PageQuerySchema,
  paginated,
} from './common';
import { UserSummarySchema } from './users';

export const MAX_COMMENT_LENGTH = 1000;

// ---- reactions ----------------------------------------------------------------------------------

export const ReactRequestSchema = z
  .object({
    type: ReactionType.schema.default('LIKE'),
    context: EventContextSchema.optional().describe(
      'Attribution for ranking: which feed request surfaced this post.',
    ),
  })
  .strict();

export const ReactionStateSchema = z
  .object({
    reaction: ReactionType.schema
      .nullable()
      .describe('Your reaction after this call (null after removing it).'),
    reactionCount: z.number().int().describe("The post's up-to-date total."),
  })
  .meta({ id: 'ReactionState' });

export const ReactionItemSchema = z
  .object({ user: UserSummarySchema, reaction: ReactionType.schema, createdAt: IsoDateTimeSchema })
  .meta({ id: 'ReactionItem' });
export const ReactionPageSchema = paginated(ReactionItemSchema, 'ReactionPage');

// ---- bookmarks & shares -------------------------------------------------------------------------

export const BookmarkStateSchema = z
  .object({ bookmarked: z.boolean() })
  .meta({ id: 'BookmarkState' });

export const ShareRequestSchema = z
  .object({ channel: ShareChannel.schema, context: EventContextSchema.optional() })
  .strict();
export const ShareResultSchema = z
  .object({ shareCount: z.number().int() })
  .meta({ id: 'ShareResult' });

// ---- comments -----------------------------------------------------------------------------------

export const CommentSchema = z
  .object({
    id: IdSchema,
    postId: IdSchema,
    author: UserSummarySchema,
    body: z.string(),
    parentId: IdSchema.nullable().describe(
      'Set for replies; always a top-level comment (threads are two levels deep).',
    ),
    replyTo: z
      .object({ id: IdSchema, username: z.string() })
      .nullable()
      .describe('Who a reply is addressed to (render as "@username").'),
    counts: z.object({ reactions: z.number().int(), replies: z.number().int() }),
    viewer: z
      .object({
        reacted: z.boolean(),
        isAuthor: z.boolean(),
        canDelete: z.boolean().describe('Comment author or post author.'),
      })
      .nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Comment' });
export type Comment = z.infer<typeof CommentSchema>;
export const CommentPageSchema = paginated(CommentSchema, 'CommentPage');

export const CreateCommentRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
    parentId: IdSchema.optional().describe(
      "Reply to this comment. Replying to a reply attaches to the thread root and addresses the reply's author.",
    ),
    context: EventContextSchema.optional(),
  })
  .strict();

export const CommentListQuerySchema = PageQuerySchema.extend({
  order: z.enum(['NEWEST', 'OLDEST']).default('NEWEST'),
});

export const CommentReactionStateSchema = z
  .object({ reacted: z.boolean(), reactionCount: z.number().int() })
  .meta({ id: 'CommentReactionState' });

export const PostIdParamSchema = z.object({ id: IdSchema });
export const CommentIdParamSchema = z.object({ commentId: IdSchema });
