import { z } from 'zod';
import type { CreateReportRequest } from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { isUniqueViolation } from '../../platform/db/errors';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import { postReadableBy } from '../posts/visibility';
import { accountVisibleTo } from '../social/visibility';

const IdCursor = z.object({ id: z.uuid() });

export interface ReportReceipt {
  id: string;
  targetType: CreateReportRequest['targetType'];
  targetId: string;
  reason: CreateReportRequest['reason'];
  status: 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';
  createdAt: string;
}

interface ReportableTarget {
  ownerId: string;
  text: string;
}

/**
 * User-facing reporting. You can only report what you can see (anything else answers *_NOT_FOUND,
 * never revealing that it exists), never your own content, and each thing once.
 */
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async create(reporterId: string, input: CreateReportRequest): Promise<ReportReceipt> {
    const target = await this.visibleTarget(reporterId, input.targetType, input.targetId);
    if (target.ownerId === reporterId) throw new AppError('SELF_ACTION_NOT_ALLOWED');

    try {
      const row = await this.db
        .insertInto('reports')
        .values({
          reporterId,
          source: 'USER',
          targetType: input.targetType,
          targetPostId: input.targetType === 'POST' ? input.targetId : null,
          targetCommentId: input.targetType === 'COMMENT' ? input.targetId : null,
          targetUserId: input.targetType === 'USER' ? input.targetId : null,
          reason: input.reason,
          details: input.details || null,
          snapshot: JSON.stringify({ text: target.text.slice(0, 2400) }),
          createdAt: this.clock.now(),
        })
        .returning(['id', 'status', 'createdAt'])
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('ALREADY_REPORTED');
      throw err;
    }
  }

  async listMine(
    reporterId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: ReportReceipt[]; nextCursor: string | null }> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.db
      .selectFrom('reports')
      .select([
        'id',
        'targetType',
        'targetPostId',
        'targetCommentId',
        'targetUserId',
        'reason',
        'status',
        'createdAt',
      ])
      .where('reporterId', '=', reporterId)
      .orderBy('id', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where('id', '<', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        targetId: (r.targetPostId ?? r.targetCommentId ?? r.targetUserId) as string,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null,
    };
  }

  /** The target as the reporter sees it, or the matching *_NOT_FOUND. */
  private async visibleTarget(
    viewerId: string,
    type: CreateReportRequest['targetType'],
    id: string,
  ): Promise<ReportableTarget> {
    if (type === 'POST') {
      const row = await this.db
        .selectFrom('posts as p')
        .innerJoin('users as au', 'au.id', 'p.authorId')
        .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
        .select(['p.authorId', 'p.caption'])
        .where('p.id', '=', id)
        .where(postReadableBy(viewerId))
        .executeTakeFirst();
      if (!row) throw new AppError('POST_NOT_FOUND');
      return { ownerId: row.authorId, text: row.caption };
    }
    if (type === 'COMMENT') {
      const row = await this.db
        .selectFrom('comments as c')
        .innerJoin('users as cu', 'cu.id', 'c.authorId')
        .innerJoin('posts as p', 'p.id', 'c.postId')
        .innerJoin('users as au', 'au.id', 'p.authorId')
        .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
        .select(['c.authorId', 'c.body'])
        .where('c.id', '=', id)
        .where('c.deletedAt', 'is', null)
        .where('c.moderationStatus', '=', 'CLEAN')
        .where(postReadableBy(viewerId))
        .where(accountVisibleTo(viewerId, { authorId: 'c.author_id', authorStatus: 'cu.status' }))
        .executeTakeFirst();
      if (!row) throw new AppError('COMMENT_NOT_FOUND');
      return { ownerId: row.authorId, text: row.body };
    }
    const row = await this.db
      .selectFrom('users as u')
      .innerJoin('profiles as p', 'p.userId', 'u.id')
      .select(['u.id', 'p.username', 'p.displayName', 'p.bio'])
      .where('u.id', '=', id)
      .where(accountVisibleTo(viewerId, { authorId: 'u.id', authorStatus: 'u.status' }))
      .executeTakeFirst();
    if (!row) throw new AppError('USER_NOT_FOUND');
    return { ownerId: row.id, text: `@${row.username} ${row.displayName}\n${row.bio}`.trim() };
  }
}
