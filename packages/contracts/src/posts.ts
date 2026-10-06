import { z } from 'zod';
import {
  CommentPermission,
  ContentVisibility,
  ModerationStatus,
  PostFormat,
  PostOrigin,
  PostStatus,
  ReactionType,
} from './enums';
import { IdSchema, IsoDateTimeSchema, PageQuerySchema, paginated } from './common';
import { ActivitySchema } from './activities';
import { SponsorshipInputSchema, SponsorshipSchema } from './creators';
import { MediaViewSchema } from './media';
import { UserSummarySchema } from './users';

export const MAX_CAPTION_LENGTH = 2200;
export const MAX_MEDIA_PER_POST = 10;
export const MAX_TOPICS_PER_POST = 10;

export const PostCountsSchema = z
  .object({
    reactions: z.number().int(),
    comments: z.number().int(),
    shares: z.number().int(),
    bookmarks: z.number().int().nullable().describe('Visible to the post author only.'),
  })
  .meta({ id: 'PostCounts' });

export const PostViewerSchema = z
  .object({
    reaction: ReactionType.schema.nullable().describe("The viewer's current reaction, if any."),
    bookmarked: z.boolean(),
    isAuthor: z.boolean(),
    canComment: z
      .boolean()
      .describe('Whether the viewer may comment right now (post setting + relationship).'),
  })
  .meta({ id: 'PostViewer' });

export const PostMentionSchema = z
  .object({ id: IdSchema, username: z.string() })
  .meta({ id: 'PostMention' });

/**
 * THE feed object. Every kind of content is a Post: an activity-only card, a raw post-run video
 * with an attached activity, a creator video, a photo, a sponsored clip. What it contains is
 * expressed by which optional parts are present, and `format` tells you which layout to use.
 *
 * `sponsorship` is NON-NULL for every sponsored/branded post. Clients must always render its
 * `label` prominently; organic content has `sponsorship: null`.
 */
export const PostSchema = z
  .object({
    id: IdSchema,
    author: UserSummarySchema,
    origin: PostOrigin.schema.describe(
      'ACTIVITY_AUTO: generated from a logged activity. AUTHORED: written by the user.',
    ),
    status: PostStatus.schema.describe('Anyone other than the author only ever sees PUBLISHED.'),
    format: PostFormat.schema.describe('Primary layout hint: VIDEO > PHOTO > ACTIVITY > TEXT.'),
    caption: z.string(),
    visibility: ContentVisibility.schema,
    commentPermission: CommentPermission.schema,
    topics: z.array(z.string()).describe('Lower-case topic slugs without the "#".'),
    mentions: z.array(PostMentionSchema),
    media: z
      .array(MediaViewSchema)
      .describe(
        'Ordered. Non-authors only receive READY media; the author also sees in-flight and failed items.',
      ),
    activity: ActivitySchema.nullable().describe(
      'The attached activity, with routes privacy-filtered for this viewer.',
    ),
    sponsorship: SponsorshipSchema.nullable(),
    counts: PostCountsSchema,
    viewer: PostViewerSchema.nullable().describe('Null for anonymous viewers.'),
    moderationStatus: ModerationStatus.schema
      .nullable()
      .describe('Author only: tells them if the post was hidden or removed.'),
    publishedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Post' });
export type Post = z.infer<typeof PostSchema>;

export const PostPageSchema = paginated(PostSchema, 'PostPage');

const TopicInput = z.string().trim().min(1).max(50);

export const CreatePostRequestSchema = z
  .object({
    caption: z.string().max(MAX_CAPTION_LENGTH).optional(),
    visibility: ContentVisibility.schema
      .optional()
      .describe('Defaults to your `defaultPostVisibility` setting.'),
    commentPermission: CommentPermission.schema
      .optional()
      .describe('Defaults to your `defaultCommentPermission` setting.'),
    activityId: IdSchema.optional().describe(
      "Attach one of YOUR activities. Others' activities are rejected.",
    ),
    mediaIds: z
      .array(IdSchema)
      .max(MAX_MEDIA_PER_POST)
      .optional()
      .describe(
        'Uploaded media (any state except FAILED/REJECTED). The post stays PENDING_MEDIA until all are READY, then publishes itself.',
      ),
    topics: z
      .array(TopicInput)
      .max(MAX_TOPICS_PER_POST)
      .optional()
      .describe('Hashtags in the caption are added automatically.'),
    sponsorship: SponsorshipInputSchema.optional().describe(
      'Required for paid/gifted/affiliate content.',
    ),
    publish: z.boolean().optional().describe('Default true. False saves a private DRAFT.'),
  })
  .strict();
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const UpdatePostRequestSchema = z
  .object({
    caption: z.string().max(MAX_CAPTION_LENGTH).optional(),
    visibility: ContentVisibility.schema
      .optional()
      .describe("Not allowed on ACTIVITY_AUTO posts: change the activity's visibility instead."),
    commentPermission: CommentPermission.schema.optional(),
    topics: z.array(TopicInput).max(MAX_TOPICS_PER_POST).optional(),
    sponsorship: SponsorshipInputSchema.nullable()
      .optional()
      .describe(
        'May be added any time. Removing it is only possible while the post is unpublished.',
      ),
  })
  .strict();
export type UpdatePostRequest = z.infer<typeof UpdatePostRequestSchema>;

export const AttachMediaRequestSchema = z
  .object({ mediaIds: z.array(IdSchema).min(1).max(MAX_MEDIA_PER_POST) })
  .strict();

export const PostMediaParamSchema = z.object({ id: IdSchema, mediaId: IdSchema });

export const UserPostsQuerySchema = PageQuerySchema.extend({
  format: PostFormat.schema.optional(),
});
export const MyPostsQuerySchema = PageQuerySchema.extend({ status: PostStatus.schema.optional() });
