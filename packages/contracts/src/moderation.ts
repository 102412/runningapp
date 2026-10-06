import { z } from 'zod';
import {
  ModerationActionType,
  ModerationStatus,
  ReportReason,
  ReportSource,
  ReportStatus,
  ReportTargetType,
  UserStatus,
  VerificationStatus,
} from './enums';
import { IdSchema, IsoDateTimeSchema, PageQuerySchema, paginated } from './common';
import { PostSchema } from './posts';
import { UserSummarySchema } from './users';

// ------------------------------------------------------------------ reporting (any user)

export const CreateReportRequestSchema = z
  .object({
    targetType: ReportTargetType.schema,
    targetId: IdSchema,
    reason: ReportReason.schema,
    details: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

/** What the reporter gets back. Moderator notes and outcomes are never exposed to reporters. */
export const ReportReceiptSchema = z
  .object({
    id: IdSchema,
    targetType: ReportTargetType.schema,
    targetId: IdSchema,
    reason: ReportReason.schema,
    status: ReportStatus.schema,
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ReportReceipt' });
export const ReportReceiptPageSchema = paginated(ReportReceiptSchema, 'ReportReceiptPage');

// ------------------------------------------------------------------ moderation queue (staff)

export const AdminReportQuerySchema = PageQuerySchema.extend({
  status: ReportStatus.schema.optional(),
  targetType: ReportTargetType.schema.optional(),
  source: ReportSource.schema.optional(),
  reason: ReportReason.schema.optional(),
});

export const ReportTargetViewSchema = z
  .object({
    type: ReportTargetType.schema,
    id: IdSchema,
    author: UserSummarySchema.nullable().describe(
      'Owner of the content (the user themself for USER targets).',
    ),
    text: z
      .string()
      .describe('Caption, comment body or profile text as it was WHEN THE REPORT WAS FILED.'),
    moderationStatus: ModerationStatus.schema
      .nullable()
      .describe('Current state of a post/comment; null for users.'),
    userStatus: UserStatus.schema.nullable().describe('Current account status of the owner.'),
    exists: z.boolean().describe('False once the content has been deleted by its author.'),
  })
  .meta({ id: 'ReportTargetView' });

export const ModerationActionSchema = z
  .object({
    id: IdSchema,
    action: ModerationActionType.schema,
    actor: UserSummarySchema.nullable().describe('Null once the moderator account is gone.'),
    reportId: IdSchema.nullable(),
    targetType: ReportTargetType.schema,
    targetId: IdSchema,
    note: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ModerationAction' });
export type ModerationAction = z.infer<typeof ModerationActionSchema>;
export const ModerationActionPageSchema = paginated(ModerationActionSchema, 'ModerationActionPage');

export const AdminReportSchema = z
  .object({
    id: IdSchema,
    source: ReportSource.schema,
    status: ReportStatus.schema,
    reason: ReportReason.schema,
    details: z.string().nullable(),
    reporter: UserSummarySchema.nullable().describe('Null for automated reports.'),
    target: ReportTargetViewSchema,
    reportCount: z.number().int().describe('Reports filed against the same target (all statuses).'),
    resolvedBy: UserSummarySchema.nullable(),
    resolvedAt: IsoDateTimeSchema.nullable(),
    resolutionNote: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'AdminReport' });
export type AdminReport = z.infer<typeof AdminReportSchema>;
export const AdminReportPageSchema = paginated(AdminReportSchema, 'AdminReportPage');

export const AdminReportDetailSchema = AdminReportSchema.extend({
  post: PostSchema.nullable().describe(
    'For POST targets (or the post a comment sits on): the post as an anonymous viewer sees it.',
  ),
  actions: z.array(ModerationActionSchema).describe('Audit trail for this target, newest first.'),
}).meta({ id: 'AdminReportDetail' });

export type AdminReportDetail = z.infer<typeof AdminReportDetailSchema>;

const NoteSchema = z.string().trim().min(1).max(1000);

export const ResolveReportRequestSchema = z
  .object({
    action: z.enum([
      'HIDE_CONTENT',
      'REMOVE_CONTENT',
      'WARN_USER',
      'SUSPEND_USER',
      'DISMISS_REPORT',
    ]),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action !== 'DISMISS_REPORT' && !v.note) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A note is required for this action.',
      });
    }
  });
export type ResolveReportRequest = z.infer<typeof ResolveReportRequestSchema>;

/** Which target types each direct action applies to. */
export const DIRECT_ACTION_TARGETS = {
  HIDE_CONTENT: ['POST', 'COMMENT'],
  REMOVE_CONTENT: ['POST', 'COMMENT'],
  RESTORE_CONTENT: ['POST', 'COMMENT'],
  SUSPEND_USER: ['USER'],
  UNSUSPEND_USER: ['USER'],
  WARN_USER: ['USER'],
  SET_CREATOR_VERIFICATION: ['USER'],
} as const;

export const ModerationActionRequestSchema = z
  .object({
    action: z.enum([
      'HIDE_CONTENT',
      'REMOVE_CONTENT',
      'RESTORE_CONTENT',
      'SUSPEND_USER',
      'UNSUSPEND_USER',
      'WARN_USER',
      'SET_CREATOR_VERIFICATION',
    ]),
    targetType: ReportTargetType.schema,
    targetId: IdSchema,
    note: NoteSchema,
    verificationStatus: VerificationStatus.schema
      .optional()
      .describe('Required for SET_CREATOR_VERIFICATION (ADMIN only).'),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed: readonly string[] = DIRECT_ACTION_TARGETS[v.action];
    if (!allowed.includes(v.targetType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetType'],
        message: `${v.action} applies to ${allowed.join(' or ')} targets.`,
      });
    }
    if (v.action === 'SET_CREATOR_VERIFICATION' && !v.verificationStatus) {
      ctx.addIssue({
        code: 'custom',
        path: ['verificationStatus'],
        message: 'verificationStatus is required for SET_CREATOR_VERIFICATION.',
      });
    }
  });
export type ModerationActionRequest = z.infer<typeof ModerationActionRequestSchema>;

export const ModerationActionsQuerySchema = PageQuerySchema.extend({
  targetType: ReportTargetType.schema.optional(),
  targetId: IdSchema.optional(),
});

export const ReportIdParamSchema = z.object({ id: IdSchema });
