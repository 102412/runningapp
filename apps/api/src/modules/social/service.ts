import { z } from 'zod';
import type { FollowRequest, UserSummary } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { isBlockedPairViolation } from '../../platform/db/errors';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import type { EventRecorder } from '../events/recorder';
import type { Notifier } from '../notifier';
import type { UserDirectory } from '../users/directory';
import { accountVisibleTo } from './visibility';

const TimeCursor = z.object({ t: z.string(), id: z.uuid() });
const IdCursor = z.object({ id: z.uuid() });

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface PageArgs {
  limit: number;
  cursor?: string | undefined;
}

export class SocialService {
  constructor(
    private readonly db: Db,
    private readonly directory: UserDirectory,
    private readonly notifier: Notifier,
    private readonly events: EventRecorder,
  ) {}

  // ------------------------------------------------------------------ follow / unfollow

  /**
   * Follows a public account immediately, or files a request against a private one.
   * Idempotent: repeating the call returns the current state without side effects.
   */
  async follow(viewerId: string, targetId: string): Promise<'FOLLOWING' | 'REQUESTED'> {
    if (viewerId === targetId) throw new AppError('SELF_ACTION_NOT_ALLOWED');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const target = await trx
          .selectFrom('profiles as p')
          .innerJoin('users as u', 'u.id', 'p.userId')
          .select(['p.accountVisibility'])
          .where('p.userId', '=', targetId)
          .where(accountVisibleTo(viewerId, { authorId: 'p.user_id', authorStatus: 'u.status' }))
          .where('u.status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (!target) throw new AppError('USER_NOT_FOUND');

        const existing = await trx
          .selectFrom('follows')
          .select('followerId')
          .where('followerId', '=', viewerId)
          .where('followeeId', '=', targetId)
          .executeTakeFirst();
        if (existing) return 'FOLLOWING';

        if (target.accountVisibility === 'PUBLIC') {
          const inserted = await trx
            .insertInto('follows')
            .values({ followerId: viewerId, followeeId: targetId })
            .onConflict((oc) => oc.doNothing())
            .returning('followerId')
            .executeTakeFirst();
          await trx
            .deleteFrom('followRequests')
            .where('requesterId', '=', viewerId)
            .where('targetId', '=', targetId)
            .execute();
          if (inserted) {
            await this.events.record(
              { userId: viewerId, type: 'FOLLOW', subjectUserId: targetId },
              trx,
            );
            await this.notifier.retract(
              { recipientId: targetId, dedupeKey: `follow_request:${viewerId}` },
              trx,
            );
            await this.notifier.notify(
              {
                recipientId: targetId,
                type: 'NEW_FOLLOWER',
                actorId: viewerId,
                dedupeKey: `follower:${viewerId}`,
              },
              trx,
            );
          }
          return 'FOLLOWING';
        }

        const request = await trx
          .insertInto('followRequests')
          .values({ requesterId: viewerId, targetId })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (request) {
          await this.notifier.notify(
            {
              recipientId: targetId,
              type: 'FOLLOW_REQUEST',
              actorId: viewerId,
              dedupeKey: `follow_request:${viewerId}`,
            },
            trx,
          );
        }
        return 'REQUESTED';
      });
    } catch (err) {
      if (isBlockedPairViolation(err)) throw new AppError('USER_NOT_FOUND');
      throw err;
    }
  }

  /** Unfollows, or withdraws a pending request. Idempotent and existence-agnostic. */
  async unfollow(viewerId: string, targetId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const removed = await trx
        .deleteFrom('follows')
        .where('followerId', '=', viewerId)
        .where('followeeId', '=', targetId)
        .executeTakeFirst();
      if (Number(removed.numDeletedRows) > 0) {
        await this.events.record(
          { userId: viewerId, type: 'UNFOLLOW', subjectUserId: targetId },
          trx,
        );
      }
      await trx
        .deleteFrom('followRequests')
        .where('requesterId', '=', viewerId)
        .where('targetId', '=', targetId)
        .execute();
      await this.notifier.retract(
        { recipientId: targetId, dedupeKey: `follower:${viewerId}` },
        trx,
      );
      await this.notifier.retract(
        { recipientId: targetId, dedupeKey: `follow_request:${viewerId}` },
        trx,
      );
    });
  }

  /** The account owner removes one of their followers. */
  async removeFollower(userId: string, followerId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('follows')
        .where('followerId', '=', followerId)
        .where('followeeId', '=', userId)
        .execute();
      await this.notifier.retract(
        { recipientId: userId, dedupeKey: `follower:${followerId}` },
        trx,
      );
    });
  }

  // ------------------------------------------------------------------ follow requests

  async listIncomingRequests(userId: string, args: PageArgs): Promise<Page<FollowRequest>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.db
      .selectFrom('followRequests as r')
      .innerJoin('users as u', 'u.id', 'r.requesterId')
      .select(['r.id', 'r.requesterId', 'r.createdAt'])
      .where('r.targetId', '=', userId)
      .where('u.status', '=', 'ACTIVE')
      .orderBy('r.id', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where('r.id', '<', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const users = await this.directory.summaries(page.map((r) => r.requesterId));
    const items = page.flatMap((r) => {
      const user = users.get(r.requesterId);
      return user ? [{ id: r.id, user, createdAt: r.createdAt.toISOString() }] : [];
    });
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }

  async acceptRequest(userId: string, requestId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const req = await trx
        .deleteFrom('followRequests')
        .where('id', '=', requestId)
        .where('targetId', '=', userId)
        .returning('requesterId')
        .executeTakeFirst();
      if (!req) throw new AppError('FOLLOW_REQUEST_NOT_FOUND');
      await this.acceptOne(trx, userId, req.requesterId);
    });
  }

  async rejectRequest(userId: string, requestId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const req = await trx
        .deleteFrom('followRequests')
        .where('id', '=', requestId)
        .where('targetId', '=', userId)
        .returning('requesterId')
        .executeTakeFirst();
      if (!req) throw new AppError('FOLLOW_REQUEST_NOT_FOUND');
      await this.notifier.retract(
        { recipientId: userId, dedupeKey: `follow_request:${req.requesterId}` },
        trx,
      );
    });
  }

  /** Used when an account switches PRIVATE -> PUBLIC: every pending request is approved. */
  async acceptAllPending(userId: string, db: Db): Promise<number> {
    const pending = await db
      .deleteFrom('followRequests')
      .where('targetId', '=', userId)
      .returning('requesterId')
      .execute();
    for (const { requesterId } of pending) await this.acceptOne(db, userId, requesterId);
    return pending.length;
  }

  private async acceptOne(db: Db, targetId: string, requesterId: string): Promise<void> {
    const inserted = await db
      .insertInto('follows')
      .values({ followerId: requesterId, followeeId: targetId })
      .onConflict((oc) => oc.doNothing())
      .returning('followerId')
      .executeTakeFirst();
    await this.notifier.retract(
      { recipientId: targetId, dedupeKey: `follow_request:${requesterId}` },
      db,
    );
    if (inserted) {
      await this.events.record(
        { userId: requesterId, type: 'FOLLOW', subjectUserId: targetId },
        db,
      );
      await this.notifier.notify(
        {
          recipientId: requesterId,
          type: 'FOLLOW_ACCEPTED',
          actorId: targetId,
          dedupeKey: `follow_accepted:${targetId}`,
        },
        db,
      );
      await this.notifier.notify(
        {
          recipientId: targetId,
          type: 'NEW_FOLLOWER',
          actorId: requesterId,
          dedupeKey: `follower:${requesterId}`,
        },
        db,
      );
    }
  }

  // ------------------------------------------------------------------ follower / following lists

  listFollowers(
    viewerId: string | null,
    targetId: string,
    args: PageArgs,
  ): Promise<Page<UserSummary>> {
    return this.listEdges(viewerId, targetId, 'followers', args);
  }

  listFollowing(
    viewerId: string | null,
    targetId: string,
    args: PageArgs,
  ): Promise<Page<UserSummary>> {
    return this.listEdges(viewerId, targetId, 'following', args);
  }

  private async listEdges(
    viewerId: string | null,
    targetId: string,
    direction: 'followers' | 'following',
    args: PageArgs,
  ): Promise<Page<UserSummary>> {
    const target = await this.db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select(['p.accountVisibility'])
      .where('p.userId', '=', targetId)
      .where(accountVisibleTo(viewerId, { authorId: 'p.user_id', authorStatus: 'u.status' }))
      .executeTakeFirst();
    if (!target) throw new AppError('USER_NOT_FOUND');

    if (target.accountVisibility === 'PRIVATE' && viewerId !== targetId) {
      const allowed =
        viewerId !== null &&
        (await this.db
          .selectFrom('follows')
          .select('followerId')
          .where('followerId', '=', viewerId)
          .where('followeeId', '=', targetId)
          .executeTakeFirst()) !== undefined;
      if (!allowed) throw new AppError('ACCOUNT_PRIVATE');
    }

    const otherSide = direction === 'followers' ? 'f.follower_id' : 'f.followee_id';
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('follows as f')
      .innerJoin('users as u', (join) =>
        join.onRef('u.id', '=', direction === 'followers' ? 'f.followerId' : 'f.followeeId'),
      )
      .select([
        direction === 'followers' ? 'f.followerId as userId' : 'f.followeeId as userId',
        timestampText('f.created_at').as('ts'),
      ])
      .where(direction === 'followers' ? 'f.followeeId' : 'f.followerId', '=', targetId)
      .where(accountVisibleTo(viewerId, { authorId: otherSide, authorStatus: 'u.status' }))
      .orderBy('f.createdAt', 'desc')
      .orderBy(direction === 'followers' ? 'f.followerId' : 'f.followeeId', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('f.created_at', otherSide, cursor));

    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const users = await this.directory.summaries(page.map((r) => r.userId));
    const items = page.flatMap((r) => {
      const u = users.get(r.userId);
      return u ? [u] : [];
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.userId }) : null,
    };
  }

  // ------------------------------------------------------------------ blocking

  /**
   * Blocks a user. The `blocks_after_insert` trigger severs follows and pending requests in both
   * directions; here we also retract notifications between the pair so nothing lingers.
   */
  async block(viewerId: string, targetId: string): Promise<void> {
    if (viewerId === targetId) throw new AppError('SELF_ACTION_NOT_ALLOWED');
    await this.db.transaction().execute(async (trx) => {
      // The target must exist, be active, and must not have blocked the viewer (in which case it
      // is invisible to them). A block the viewer already placed is fine: blocking is idempotent.
      const target = await trx
        .selectFrom('users as u')
        .select('u.id')
        .where('u.id', '=', targetId)
        .where('u.status', '=', 'ACTIVE')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('blocks as b')
                .select('b.blockerId')
                .where('b.blockerId', '=', targetId)
                .where('b.blockedId', '=', viewerId),
            ),
          ),
        )
        .executeTakeFirst();
      if (!target) throw new AppError('USER_NOT_FOUND');
      await trx
        .insertInto('blocks')
        .values({ blockerId: viewerId, blockedId: targetId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .deleteFrom('notifications')
        .where((eb) =>
          eb.or([
            eb.and([eb('recipientId', '=', viewerId), eb('actorId', '=', targetId)]),
            eb.and([eb('recipientId', '=', targetId), eb('actorId', '=', viewerId)]),
          ]),
        )
        .execute();
    });
  }

  async unblock(viewerId: string, targetId: string): Promise<void> {
    await this.db
      .deleteFrom('blocks')
      .where('blockerId', '=', viewerId)
      .where('blockedId', '=', targetId)
      .execute();
  }

  async listBlocks(
    viewerId: string,
    args: PageArgs,
  ): Promise<Page<{ user: UserSummary; blockedAt: string }>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('blocks as b')
      .select(['b.blockedId', timestampText('b.created_at').as('ts')])
      .where('b.blockerId', '=', viewerId)
      .orderBy('b.createdAt', 'desc')
      .orderBy('b.blockedId', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('b.created_at', 'b.blocked_id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const users = await this.directory.summaries(page.map((r) => r.blockedId));
    const items = page.flatMap((r) => {
      const user = users.get(r.blockedId);
      return user ? [{ user, blockedAt: r.ts }] : [];
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.blockedId }) : null,
    };
  }
}
