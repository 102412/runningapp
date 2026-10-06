import { z } from 'zod';
import { NotificationType, PostFormat, PushProviderName } from './enums';
import { IdSchema, IsoDateTimeSchema, PageQuerySchema, paginated } from './common';
import { UserSummarySchema } from './users';

export const NotificationPostPreviewSchema = z
  .object({
    id: IdSchema,
    format: PostFormat.schema,
    thumbnailUrl: z
      .string()
      .nullable()
      .describe('Signed thumbnail of the first media item, when the post has any.'),
    captionExcerpt: z.string().describe('First ~100 characters of the caption.'),
  })
  .meta({ id: 'NotificationPostPreview' });

export const NotificationSchema = z
  .object({
    id: IdSchema,
    type: NotificationType.schema,
    actor: UserSummarySchema.nullable().describe('Who did it. Null for system notifications.'),
    post: NotificationPostPreviewSchema.nullable(),
    comment: z.object({ id: IdSchema, excerpt: z.string() }).nullable(),
    followRequestId: IdSchema.nullable().describe(
      'For FOLLOW_REQUEST while still pending: use it to accept/reject inline.',
    ),
    data: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe('Type-specific extras (e.g. `reaction`, `mediaId`, `reason`).'),
    readAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof NotificationSchema>;
export const NotificationPageSchema = paginated(NotificationSchema, 'NotificationPage');

export const NotificationListQuerySchema = PageQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const UnreadCountSchema = z
  .object({ count: z.number().int().describe('Capped at 100: show "99+" when it is 100.') })
  .meta({ id: 'UnreadCount' });

export const MarkReadRequestSchema = z
  .object({
    ids: z.array(IdSchema).min(1).max(100).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.ids !== undefined) !== (v.all === true), {
    message: 'Provide exactly one of `ids` or `all: true`.',
  });
export const MarkReadResultSchema = z
  .object({ updated: z.number().int() })
  .meta({ id: 'MarkReadResult' });

export const NotificationPreferenceSchema = z
  .object({ type: NotificationType.schema, inApp: z.boolean(), push: z.boolean() })
  .meta({ id: 'NotificationPreference' });
export const NotificationPreferencesSchema = z
  .object({ items: z.array(NotificationPreferenceSchema) })
  .meta({
    id: 'NotificationPreferences',
    description: 'One entry per notification type. Defaults: everything on.',
  });
export const UpdateNotificationPreferencesRequestSchema = z
  .object({ items: z.array(NotificationPreferenceSchema).min(1).max(30) })
  .strict();

export const RegisterPushTokenRequestSchema = z
  .object({
    provider: PushProviderName.schema,
    token: z.string().min(10).max(4096),
    installId: z
      .string()
      .min(8)
      .max(128)
      .optional()
      .describe('Required only if you signed in without `device` info.'),
    platform: z.enum(['IOS', 'ANDROID', 'WEB']).optional(),
  })
  .strict();
