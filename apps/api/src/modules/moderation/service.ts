import { z } from 'zod';
import type {
  AdminReport,
  AdminReportDetail,
  ModerationAction,
  ModerationActionRequest,
  ModerationStatus,
  ReportReason,
  ReportSource,
  ReportStatus,
  ReportTargetType,
  ResolveReportRequest,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import { uuidv7 } from '../../platform/ids';
import { POST_COLUMNS, type PostHydrator } from '../posts/hydrator';
import type { Notifier } from '../notifier';
import type { UserDirectory } from '../users/directory';

const IdCursor = z.object({ id: z.uuid() });
const ROLE_RANK: Record<UserRole, number> = { USER: 0, MODERATOR: 1, ADMIN: 2 };
type Action = ModerationActionRequest['action'] | 'DISMISS_REPORT';

export interface StaffActor {
  userId: string;
  role: UserRole;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** A moderation target as it is right now (staff are not subject to viewer visibility). */
interface Target {
  type: ReportTargetType;
  /** The post or comment id; null for USER targets. */
  contentId: string | null;
  /** The post a comment belongs to (the post itself for POST targets). */
  postId: string | null;
  ownerId: string;
  ownerRole: UserRole;
  ownerStatus: UserStatus;
  moderationStatus: ModerationStatus | null;
  text: string;
  exists: boolean;
}

interface ReportRow {
  id: string;
  reporterId: string | null;
  source: ReportSource;
  targetType: ReportTargetType;
  targetPostId: string | null;
  targetCommentId: string | null;
  targetUserId: string | null;
  reason: ReportReason;
  details: string | null;
  snapshot: unknown;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

/**
 * Staff-side moderation: the report queue and every action a moderator can take. Each action
 *  - is permission-checked (a moderator cannot act on staff; verification is ADMIN-only),
 *  - changes state with a compare-and-set, so races are rejected instead of silently applied,
 *  - is written to the append-only `moderation_actions` audit trail in the SAME transaction,
 *  - and notifies the affected user where that makes sense.
 * Hiding content never deletes it: it can be restored, and the author can see its state.
 */
export class ModerationService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly directory: UserDirectory,
    private readonly hydrator: PostHydrator,
    private readonly notifier: Notifier,
  ) {}

  // ------------------------------------------------------------------ queue

  async listReports(args: {
    limit: number;
    cursor?: string | undefined;
    status?: ReportStatus | undefined;
    targetType?: ReportTargetType | undefined;
    source?: ReportSource | undefined;
    reason?: ReportReason | undefined;
  }): Promise<Page<AdminReport>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.db
      .selectFrom('reports')
      .selectAll()
      .orderBy('id') // oldest first: a queue
      .limit(args.limit + 1);
    if (args.status) q = q.where('status', '=', args.status);
    if (args.targetType) q = q.where('targetType', '=', args.targetType);
    if (args.source) q = q.where('source', '=', args.source);
    if (args.reason) q = q.where('reason', '=', args.reason);
    if (cursor) q = q.where('id', '>', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const last = page[page.length - 1];
    return {
      items: await this.toAdminReports(page),
      nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null,
    };
  }

  async getReport(id: string): Promise<AdminReportDetail> {
    const row = await this.db
      .selectFrom('reports')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('REPORT_NOT_FOUND');
    const [report] = await this.toAdminReports([row]);
    if (!report) throw new AppError('REPORT_NOT_FOUND');

    const targetId = row.targetPostId ?? row.targetCommentId ?? row.targetUserId;
    const target = await this.loadTarget(this.db, row.targetType, targetId as string).catch(
      () => null,
    );
    let post: AdminReportDetail['post'] = null;
    if (target?.postId) {
      const postRow = await this.db
        .selectFrom('posts as p')
        .select(POST_COLUMNS)
        .where('p.id', '=', target.postId)
        .executeTakeFirst();
      // Hydrated as an anonymous viewer: staff review what the public would see (routes are
      // privacy-filtered, only READY media), not the author's private view.
      if (postRow) post = (await this.hydrator.hydrate(null, [postRow]))[0] ?? null;
    }
    const actions = await this.actionsFor(row.targetType, targetId as string, 50);
    return { ...report, post, actions };
  }

  // ------------------------------------------------------------------ resolving a report

  async resolveReport(
    actor: StaffActor,
    reportId: string,
    req: ResolveReportRequest,
  ): Promise<AdminReportDetail> {
    await this.db.transaction().execute(async (trx) => {
      const report = await trx
        .selectFrom('reports')
        .selectAll()
        .where('id', '=', reportId)
        .forUpdate()
        .executeTakeFirst();
      if (!report) throw new AppError('REPORT_NOT_FOUND');
      if (report.status === 'ACTIONED' || report.status === 'DISMISSED') {
        throw new AppError('INVALID_STATE', { message: 'This report is already resolved.' });
      }
      const targetId = (report.targetPostId ??
        report.targetCommentId ??
        report.targetUserId) as string;
      const target = await this.loadTarget(trx, report.targetType, targetId);
      const dismiss = req.action === 'DISMISS_REPORT';

      // The audit row is written AFTER the effect succeeded but in the same transaction, so it
      // exists if and only if the action happened (it is append-only and can never be amended).
      const actionId = uuidv7();
      const metadata = dismiss
        ? {}
        : await this.applyEffect(trx, actor, req.action, target, req.note ?? '', actionId);
      await this.record(trx, actionId, actor, req.action, target, {
        reportId,
        note: req.note ?? null,
        metadata,
      });

      const now = this.clock.now();
      await trx
        .updateTable('reports')
        .set({
          status: dismiss ? 'DISMISSED' : 'ACTIONED',
          resolvedBy: actor.userId,
          resolvedAt: now,
          resolutionNote: req.note ?? null,
        })
        .where('id', '=', reportId)
        .execute();
      // Acting on the content settles every other open report about it too.
      if (!dismiss) await this.closeOpenReports(trx, actor, target, req.note ?? null, reportId);
    });
    return this.getReport(reportId);
  }

  // ------------------------------------------------------------------ direct actions

  async act(actor: StaffActor, req: ModerationActionRequest): Promise<ModerationAction> {
    const actionId = await this.db.transaction().execute(async (trx) => {
      const target = await this.loadTarget(trx, req.targetType, req.targetId);
      const id = uuidv7();
      const metadata = await this.applyEffect(
        trx,
        actor,
        req.action,
        target,
        req.note,
        id,
        req.verificationStatus,
      );
      await this.record(trx, id, actor, req.action, target, {
        reportId: null,
        note: req.note,
        metadata,
      });
      const settles = !['RESTORE_CONTENT', 'UNSUSPEND_USER', 'SET_CREATOR_VERIFICATION'].includes(
        req.action,
      );
      if (settles) await this.closeOpenReports(trx, actor, target, req.note, null);
      return id;
    });
    const row = await this.db
      .selectFrom('moderationActions')
      .selectAll()
      .where('id', '=', actionId)
      .executeTakeFirstOrThrow();
    const [dto] = await this.toActionDtos([row]);
    if (!dto) throw new AppError('INTERNAL');
    return dto;
  }

  async listActions(args: {
    limit: number;
    cursor?: string | undefined;
    targetType?: ReportTargetType | undefined;
    targetId?: string | undefined;
  }): Promise<Page<ModerationAction>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.db
      .selectFrom('moderationActions')
      .selectAll()
      .orderBy('id', 'desc')
      .limit(args.limit + 1);
    if (args.targetType) q = q.where('targetType', '=', args.targetType);
    if (args.targetId) {
      const id = args.targetId;
      q = q.where((eb) =>
        eb.or([
          eb('targetPostId', '=', id),
          eb('targetCommentId', '=', id),
          eb('targetUserId', '=', id),
        ]),
      );
    }
    if (cursor) q = q.where('id', '<', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const last = page[page.length - 1];
    return {
      items: await this.toActionDtos(page),
      nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null,
    };
  }

  // ------------------------------------------------------------------ effects

  /** Applies one action's effect. Returns metadata for the audit row. */
  private async applyEffect(
    trx: Db,
    actor: StaffActor,
    action: Action,
    target: Target,
    note: string,
    actionId: string,
    verification?: VerificationStatus,
  ): Promise<Record<string, unknown>> {
    if (action === 'SET_CREATOR_VERIFICATION' && ROLE_RANK[actor.role] < ROLE_RANK.ADMIN) {
      throw new AppError('INSUFFICIENT_ROLE', {
        message: 'Only admins can change creator verification.',
      });
    }
    // Staff can only act on people ranked below them (and never on themselves).
    if (ROLE_RANK[actor.role] <= ROLE_RANK[target.ownerRole]) {
      throw new AppError('INSUFFICIENT_ROLE', {
        message: 'You cannot take moderation action against this account.',
      });
    }

    const content = target.contentId !== null;
    const needContent = () => {
      if (!content) {
        throw new AppError('INVALID_STATE', {
          message: `${action} applies to posts and comments, not accounts.`,
        });
      }
    };
    const now = this.clock.now();

    switch (action) {
      case 'HIDE_CONTENT':
      case 'REMOVE_CONTENT':
      case 'RESTORE_CONTENT': {
        needContent();
        const to: ModerationStatus =
          action === 'HIDE_CONTENT' ? 'HIDDEN' : action === 'REMOVE_CONTENT' ? 'REMOVED' : 'CLEAN';
        const from: ModerationStatus[] =
          action === 'HIDE_CONTENT'
            ? ['CLEAN']
            : action === 'REMOVE_CONTENT'
              ? ['CLEAN', 'HIDDEN']
              : ['HIDDEN', 'REMOVED'];
        const table = target.type === 'POST' ? 'posts' : 'comments';
        const res = await trx
          .updateTable(table)
          .set({ moderationStatus: to })
          .where('id', '=', target.contentId as string)
          .where('moderationStatus', 'in', from)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) {
          throw new AppError('INVALID_STATE', {
            message: `The ${target.type.toLowerCase()} is ${(target.moderationStatus ?? 'CLEAN').toLowerCase()}, so ${action} does not apply.`,
          });
        }
        await this.tellOwner(trx, target, actionId, {
          action,
          targetType: target.type,
        });
        return { from: target.moderationStatus, to };
      }

      case 'WARN_USER': {
        // The note of a warning is addressed to the user, so it is the one note they get to read.
        await this.tellOwner(trx, target, actionId, {
          action,
          targetType: target.type,
          message: note.slice(0, 1000),
        });
        return {};
      }

      case 'SUSPEND_USER': {
        const res = await trx
          .updateTable('users')
          .set({ status: 'SUSPENDED', suspendedAt: now })
          .where('id', '=', target.ownerId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) {
          throw new AppError('INVALID_STATE', {
            message: 'Only active accounts can be suspended.',
          });
        }
        return { userId: target.ownerId };
      }

      case 'UNSUSPEND_USER': {
        const res = await trx
          .updateTable('users')
          .set({ status: 'ACTIVE', suspendedAt: null })
          .where('id', '=', target.ownerId)
          .where('status', '=', 'SUSPENDED')
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) {
          throw new AppError('INVALID_STATE', { message: 'This account is not suspended.' });
        }
        return { userId: target.ownerId };
      }

      case 'SET_CREATOR_VERIFICATION': {
        if (!verification) throw new AppError('VALIDATION_FAILED');
        const res = await trx
          .updateTable('creatorProfiles')
          .set({
            verificationStatus: verification,
            verifiedAt: verification === 'VERIFIED' ? now : null,
            verifiedBy: verification === 'VERIFIED' ? actor.userId : null,
          })
          .where('userId', '=', target.ownerId)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) {
          throw new AppError('INVALID_STATE', { message: 'This user has no creator profile.' });
        }
        return { verificationStatus: verification };
      }

      case 'DISMISS_REPORT':
        return {};
    }
  }

  private async tellOwner(
    trx: Db,
    target: Target,
    actionId: string,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.notifier.notify(
      {
        recipientId: target.ownerId,
        type: 'MODERATION_ACTION',
        actorId: null, // the moderator's identity is never shown to the user
        postId: target.type === 'POST' ? target.contentId : null,
        commentId: target.type === 'COMMENT' ? target.contentId : null,
        data,
        dedupeKey: `moderation:${actionId}`,
      },
      trx,
    );
  }

  // ------------------------------------------------------------------ audit + bookkeeping

  private async record(
    trx: Db,
    id: string,
    actor: StaffActor,
    action: Action,
    target: Target,
    extra: { reportId: string | null; note: string | null; metadata: Record<string, unknown> },
  ): Promise<void> {
    await trx
      .insertInto('moderationActions')
      .values({
        id,
        actorId: actor.userId,
        action,
        reportId: extra.reportId,
        targetType: target.type,
        targetPostId: target.type === 'POST' ? target.contentId : null,
        targetCommentId: target.type === 'COMMENT' ? target.contentId : null,
        // Content actions also record the owner so "everything done about this user" is one query.
        targetUserId: target.ownerId,
        note: extra.note,
        metadata: JSON.stringify(extra.metadata),
        createdAt: this.clock.now(),
      })
      .execute();
  }

  private async closeOpenReports(
    trx: Db,
    actor: StaffActor,
    target: Target,
    note: string | null,
    exceptId: string | null,
  ): Promise<void> {
    let q = trx
      .updateTable('reports')
      .set({
        status: 'ACTIONED',
        resolvedBy: actor.userId,
        resolvedAt: this.clock.now(),
        resolutionNote: note,
      })
      .where('status', 'in', ['OPEN', 'IN_REVIEW'])
      .where('targetType', '=', target.type);
    if (target.type === 'POST') q = q.where('targetPostId', '=', target.contentId as string);
    else if (target.type === 'COMMENT')
      q = q.where('targetCommentId', '=', target.contentId as string);
    else q = q.where('targetUserId', '=', target.ownerId);
    if (exceptId) q = q.where('id', '!=', exceptId);
    await q.execute();
  }

  // ------------------------------------------------------------------ loading

  private async loadTarget(db: Db, type: ReportTargetType, id: string): Promise<Target> {
    if (type === 'POST') {
      const r = await db
        .selectFrom('posts as p')
        .innerJoin('users as u', 'u.id', 'p.authorId')
        .select([
          'p.id',
          'p.authorId',
          'p.moderationStatus',
          'p.deletedAt',
          'p.caption',
          'u.role',
          'u.status',
        ])
        .where('p.id', '=', id)
        .executeTakeFirst();
      if (!r) throw new AppError('POST_NOT_FOUND');
      return {
        type,
        contentId: r.id,
        postId: r.id,
        ownerId: r.authorId,
        ownerRole: r.role,
        ownerStatus: r.status,
        moderationStatus: r.moderationStatus,
        text: r.caption,
        exists: r.deletedAt === null,
      };
    }
    if (type === 'COMMENT') {
      const r = await db
        .selectFrom('comments as c')
        .innerJoin('users as u', 'u.id', 'c.authorId')
        .select([
          'c.id',
          'c.postId',
          'c.authorId',
          'c.moderationStatus',
          'c.deletedAt',
          'c.body',
          'u.role',
          'u.status',
        ])
        .where('c.id', '=', id)
        .executeTakeFirst();
      if (!r) throw new AppError('COMMENT_NOT_FOUND');
      return {
        type,
        contentId: r.id,
        postId: r.postId,
        ownerId: r.authorId,
        ownerRole: r.role,
        ownerStatus: r.status,
        moderationStatus: r.moderationStatus,
        text: r.body,
        exists: r.deletedAt === null,
      };
    }
    const r = await db
      .selectFrom('users as u')
      .innerJoin('profiles as p', 'p.userId', 'u.id')
      .select(['u.id', 'u.role', 'u.status', 'p.username', 'p.displayName', 'p.bio'])
      .where('u.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new AppError('USER_NOT_FOUND');
    return {
      type,
      contentId: null,
      postId: null,
      ownerId: r.id,
      ownerRole: r.role,
      ownerStatus: r.status,
      moderationStatus: null,
      text: `@${r.username} ${r.displayName}\n${r.bio}`.trim(),
      exists: true,
    };
  }

  private async actionsFor(
    type: ReportTargetType,
    targetId: string,
    limit: number,
  ): Promise<ModerationAction[]> {
    const column =
      type === 'POST' ? 'targetPostId' : type === 'COMMENT' ? 'targetCommentId' : 'targetUserId';
    const rows = await this.db
      .selectFrom('moderationActions')
      .selectAll()
      .where(column, '=', targetId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return this.toActionDtos(rows);
  }

  // ------------------------------------------------------------------ DTOs

  private async toActionDtos(
    rows: Array<{
      id: string;
      actorId: string;
      action: ModerationAction['action'];
      reportId: string | null;
      targetType: ReportTargetType;
      targetPostId: string | null;
      targetCommentId: string | null;
      targetUserId: string | null;
      note: string | null;
      metadata: unknown;
      createdAt: Date;
    }>,
  ): Promise<ModerationAction[]> {
    const actors = await this.directory.summaries(rows.map((r) => r.actorId));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: actors.get(r.actorId) ?? null,
      reportId: r.reportId,
      targetType: r.targetType,
      targetId: (r.targetPostId ?? r.targetCommentId ?? r.targetUserId) as string,
      note: r.note,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async toAdminReports(rows: ReportRow[]): Promise<AdminReport[]> {
    if (rows.length === 0) return [];
    const ids = (pick: (r: ReportRow) => string | null) => [
      ...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : []))),
    ];
    const postIds = ids((r) => r.targetPostId);
    const commentIds = ids((r) => r.targetCommentId);
    const userIds = ids((r) => r.targetUserId);

    const [posts, comments, users, postCounts, commentCounts, userCounts] = await Promise.all([
      postIds.length === 0
        ? []
        : this.db
            .selectFrom('posts')
            .select(['id', 'authorId', 'moderationStatus', 'deletedAt'])
            .where('id', 'in', postIds)
            .execute(),
      commentIds.length === 0
        ? []
        : this.db
            .selectFrom('comments')
            .select(['id', 'authorId', 'moderationStatus', 'deletedAt'])
            .where('id', 'in', commentIds)
            .execute(),
      userIds.length === 0
        ? []
        : this.db.selectFrom('users').select(['id', 'status']).where('id', 'in', userIds).execute(),
      this.countBy('targetPostId', postIds),
      this.countBy('targetCommentId', commentIds),
      this.countBy('targetUserId', userIds),
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));

    // Owners of the targets, to show who is being reported (comments/posts: their author).
    const ownerOf = (r: ReportRow): string | null =>
      r.targetPostId
        ? (postById.get(r.targetPostId)?.authorId ?? null)
        : r.targetCommentId
          ? (commentById.get(r.targetCommentId)?.authorId ?? null)
          : r.targetUserId;
    const people = await this.directory.summaries(
      rows.flatMap((r) =>
        [r.reporterId, r.resolvedBy, ownerOf(r)].filter((x): x is string => x !== null),
      ),
    );

    return rows.map((r) => {
      const ownerId = ownerOf(r);
      const post = r.targetPostId ? postById.get(r.targetPostId) : undefined;
      const comment = r.targetCommentId ? commentById.get(r.targetCommentId) : undefined;
      const user = r.targetUserId ? userById.get(r.targetUserId) : undefined;
      const targetId = (r.targetPostId ?? r.targetCommentId ?? r.targetUserId) as string;
      const count =
        (r.targetPostId
          ? postCounts.get(r.targetPostId)
          : r.targetCommentId
            ? commentCounts.get(r.targetCommentId)
            : userCounts.get(r.targetUserId as string)) ?? 1;
      const snapshot = (r.snapshot ?? {}) as { text?: string };
      return {
        id: r.id,
        source: r.source,
        status: r.status,
        reason: r.reason,
        details: r.details,
        reporter: r.reporterId ? (people.get(r.reporterId) ?? null) : null,
        target: {
          type: r.targetType,
          id: targetId,
          author: ownerId ? (people.get(ownerId) ?? null) : null,
          text: snapshot.text ?? '',
          moderationStatus: post?.moderationStatus ?? comment?.moderationStatus ?? null,
          userStatus: user?.status ?? null,
          exists: post ? post.deletedAt === null : comment ? comment.deletedAt === null : !!user,
        },
        reportCount: count,
        resolvedBy: r.resolvedBy ? (people.get(r.resolvedBy) ?? null) : null,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolutionNote: r.resolutionNote,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  private async countBy(
    column: 'targetPostId' | 'targetCommentId' | 'targetUserId',
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('reports')
      .select([column, (eb) => eb.fn.countAll<number>().as('n')])
      .where(column, 'in', ids)
      .groupBy(column)
      .execute();
    return new Map(rows.map((r) => [r[column] as string, Number(r.n)]));
  }
}
