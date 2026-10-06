import { z } from 'zod';
import type {
  Comment,
  EventContext,
  Post,
  ReactionType,
  ShareChannel,
} from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import type { ContentModerator } from '../../platform/ports/content-moderation';
import type { EventRecorder } from '../events/recorder';
import type { Notifier } from '../notifier';
import { canComment, POST_COLUMNS, type PostHydrator, type PostRow } from '../posts/hydrator';
import { extractMentions } from '../posts/text';
import { postListableBy } from '../posts/visibility';
import type { PostService } from '../posts/service';
import { accountVisibleTo } from '../social/visibility';
import type { UserDirectory } from '../users/directory';

const IdCursor = z.object({ id: z.uuid() });
const TimeCursor = z.object({ t: z.string(), id: z.uuid() });

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface CommentRow {
  id: string;
  postId: string;
  authorId: string;
  parentId: string | null;
  replyToUserId: string | null;
  body: string;
  reactionCount: number;
  replyCount: number;
  createdAt: Date;
  postAuthorId: string;
}

const COMMENT_COLUMNS = [
  'c.id',
  'c.postId',
  'c.authorId',
  'c.parentId',
  'c.replyToUserId',
  'c.body',
  'c.reactionCount',
  'c.replyCount',
  'c.createdAt',
  'p.authorId as postAuthorId',
] as const;

/** Reactions, comments, bookmarks and shares. Every action re-checks that the viewer can see the post. */
export class EngagementService {
  constructor(
    private readonly db: Db,
    private readonly posts: PostService,
    private readonly hydrator: PostHydrator,
    private readonly directory: UserDirectory,
    private readonly notifier: Notifier,
    private readonly moderator: ContentModerator,
    private readonly events: EventRecorder,
  ) {}

  // ------------------------------------------------------------------ guards

  /** The post, if the viewer may interact with it (visible, published, clean). Otherwise POST_NOT_FOUND. */
  private async interactable(viewerId: string, postId: string): Promise<PostRow> {
    const row = await this.posts.getRow(viewerId, postId);
    if (row.status !== 'PUBLISHED' || row.moderationStatus !== 'CLEAN')
      throw new AppError('POST_NOT_FOUND');
    return row;
  }

  // ------------------------------------------------------------------ post reactions

  /** Idempotent: reacting twice keeps one reaction; sending a different type changes it. */
  async react(
    userId: string,
    postId: string,
    type: ReactionType,
    context?: EventContext,
  ): Promise<{ reaction: ReactionType; reactionCount: number }> {
    const post = await this.interactable(userId, postId);
    const count = await this.db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('postReactions')
        .select('reaction')
        .where('postId', '=', postId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      await trx
        .insertInto('postReactions')
        .values({ postId, userId, reaction: type })
        .onConflict((oc) => oc.columns(['postId', 'userId']).doUpdateSet({ reaction: type }))
        .execute();
      if (!before) {
        await this.notifier.notify(
          {
            recipientId: post.authorId,
            type: 'POST_REACTION',
            actorId: userId,
            postId,
            data: { reaction: type },
            dedupeKey: `reaction:${postId}:${userId}`,
          },
          trx,
        );
        await this.events.record({ userId, type: 'LIKE', postId, context }, trx);
      }
      const row = await trx
        .selectFrom('posts')
        .select('reactionCount')
        .where('id', '=', postId)
        .executeTakeFirstOrThrow();
      return row.reactionCount;
    });
    return { reaction: type, reactionCount: count };
  }

  async unreact(
    userId: string,
    postId: string,
    context?: EventContext,
  ): Promise<{ reaction: null; reactionCount: number }> {
    return this.db.transaction().execute(async (trx) => {
      const post = await trx
        .selectFrom('posts')
        .select(['authorId', 'reactionCount'])
        .where('id', '=', postId)
        .executeTakeFirst();
      const removed = await trx
        .deleteFrom('postReactions')
        .where('postId', '=', postId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      if (post && Number(removed.numDeletedRows) > 0) {
        await this.notifier.retract(
          { recipientId: post.authorId, dedupeKey: `reaction:${postId}:${userId}` },
          trx,
        );
        await this.events.record({ userId, type: 'UNLIKE', postId, context }, trx);
      }
      const row = await trx
        .selectFrom('posts')
        .select('reactionCount')
        .where('id', '=', postId)
        .executeTakeFirst();
      return { reaction: null, reactionCount: row?.reactionCount ?? 0 };
    });
  }

  async listReactions(
    viewerId: string,
    postId: string,
    args: { limit: number; cursor?: string | undefined },
  ) {
    await this.posts.getRow(viewerId, postId);
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('postReactions as r')
      .innerJoin('users as u', 'u.id', 'r.userId')
      .select(['r.userId', 'r.reaction', timestampText('r.created_at').as('ts'), 'r.createdAt'])
      .where('r.postId', '=', postId)
      .where(accountVisibleTo(viewerId, { authorId: 'r.user_id', authorStatus: 'u.status' }))
      .orderBy('r.createdAt', 'desc')
      .orderBy('r.userId', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('r.created_at', 'r.user_id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const users = await this.directory.summaries(page.map((r) => r.userId));
    const items = page.flatMap((r) => {
      const user = users.get(r.userId);
      return user ? [{ user, reaction: r.reaction, createdAt: r.createdAt.toISOString() }] : [];
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.userId }) : null,
    };
  }

  // ------------------------------------------------------------------ bookmarks

  async bookmark(userId: string, postId: string, context?: EventContext): Promise<void> {
    await this.interactable(userId, postId);
    await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('bookmarks')
        .values({ userId, postId })
        .onConflict((oc) => oc.doNothing())
        .returning('postId')
        .executeTakeFirst();
      if (inserted) await this.events.record({ userId, type: 'BOOKMARK', postId, context }, trx);
    });
  }

  async unbookmark(userId: string, postId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const removed = await trx
        .deleteFrom('bookmarks')
        .where('userId', '=', userId)
        .where('postId', '=', postId)
        .executeTakeFirst();
      if (Number(removed.numDeletedRows) > 0)
        await this.events.record({ userId, type: 'UNBOOKMARK', postId }, trx);
    });
  }

  /** Bookmarks the user can still open: a post that has since become private or been removed drops out. */
  async listBookmarks(
    userId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<Page<Post>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('bookmarks as b')
      .innerJoin('posts as p', 'p.id', 'b.postId')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select([...POST_COLUMNS, timestampText('b.created_at').as('ts')])
      .where('b.userId', '=', userId)
      .where(postListableBy(userId))
      .orderBy('b.createdAt', 'desc')
      .orderBy('b.postId', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('b.created_at', 'b.post_id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrator.hydrate(userId, page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  // ------------------------------------------------------------------ shares

  async share(
    userId: string,
    postId: string,
    channel: ShareChannel,
    context?: EventContext,
  ): Promise<{ shareCount: number }> {
    await this.interactable(userId, postId);
    return this.db.transaction().execute(async (trx) => {
      await trx.insertInto('shares').values({ postId, userId, channel }).execute();
      await this.events.record({ userId, type: 'SHARE', postId, context }, trx);
      const row = await trx
        .selectFrom('posts')
        .select('shareCount')
        .where('id', '=', postId)
        .executeTakeFirstOrThrow();
      return { shareCount: row.shareCount };
    });
  }

  // ------------------------------------------------------------------ comments

  async createComment(
    userId: string,
    postId: string,
    input: { body: string; parentId?: string | undefined; context?: EventContext | undefined },
  ): Promise<Comment> {
    const body = input.body.trim();
    const verdict = await this.moderator.moderateText({ text: body, context: 'COMMENT' });
    if (verdict.verdict === 'BLOCK')
      throw new AppError('CONTENT_REJECTED', {
        details: [{ path: 'body', message: verdict.reason }],
      });

    const post = await this.interactable(userId, postId);
    const follows =
      (await this.db
        .selectFrom('follows')
        .select('followerId')
        .where('followerId', '=', userId)
        .where('followeeId', '=', post.authorId)
        .executeTakeFirst()) !== undefined;
    if (!canComment(post, userId, follows)) throw new AppError('COMMENTS_RESTRICTED');

    const commentId = await this.db.transaction().execute(async (trx) => {
      let parentId: string | null = null;
      let replyToUserId: string | null = null;
      if (input.parentId) {
        const parent = await this.visibleCommentRow(trx, userId, input.parentId);
        if (parent.postId !== postId) throw new AppError('COMMENT_NOT_FOUND');
        // Threads are two levels deep: replying to a reply attaches to its root and addresses its author.
        parentId = parent.parentId ?? parent.id;
        replyToUserId = parent.authorId;
      }
      const row = await trx
        .insertInto('comments')
        .values({ postId, authorId: userId, parentId, replyToUserId, body })
        .returning('id')
        .executeTakeFirstOrThrow();

      const mentioned = await this.resolveMentions(trx, userId, body);
      if (mentioned.length > 0)
        await trx
          .insertInto('commentMentions')
          .values(mentioned.map((m) => ({ commentId: row.id, userId: m })))
          .execute();

      // One notification per recipient per comment; the most specific reason wins.
      const recipients = new Map<string, 'POST_COMMENT' | 'COMMENT_REPLY' | 'MENTION_COMMENT'>();
      if (post.authorId !== userId) recipients.set(post.authorId, 'POST_COMMENT');
      if (replyToUserId && replyToUserId !== userId) recipients.set(replyToUserId, 'COMMENT_REPLY');
      for (const m of mentioned)
        if (m !== userId && !recipients.has(m)) recipients.set(m, 'MENTION_COMMENT');
      for (const [recipientId, type] of recipients) {
        await this.notifier.notify(
          {
            recipientId,
            type,
            actorId: userId,
            postId,
            commentId: row.id,
            data: { excerpt: body.slice(0, 100) },
            dedupeKey: `comment:${row.id}`,
          },
          trx,
        );
      }
      await this.events.record({ userId, type: 'COMMENT', postId, context: input.context }, trx);
      return row.id;
    });
    const [comment] = await this.hydrateComments(userId, [await this.commentRow(commentId)]);
    if (!comment) throw new AppError('COMMENT_NOT_FOUND');
    return comment;
  }

  /** Top-level comments of a post the viewer can see. Replies come from listReplies. */
  async listComments(
    viewerId: string | null,
    postId: string,
    args: { limit: number; cursor?: string | undefined; order: 'NEWEST' | 'OLDEST' },
  ): Promise<Page<Comment>> {
    await this.posts.getRow(viewerId, postId);
    return this.listCommentRows(viewerId, args, (q) =>
      q.where('c.postId', '=', postId).where('c.parentId', 'is', null),
    );
  }

  async listReplies(
    viewerId: string | null,
    commentId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<Page<Comment>> {
    const parent = await this.visibleCommentRow(this.db, viewerId, commentId);
    await this.posts.getRow(viewerId, parent.postId);
    return this.listCommentRows(viewerId, { ...args, order: 'OLDEST' }, (q) =>
      q.where('c.parentId', '=', commentId),
    );
  }

  private async listCommentRows(
    viewerId: string | null,
    args: { limit: number; cursor?: string | undefined; order: 'NEWEST' | 'OLDEST' },
    scope: (
      q: ReturnType<EngagementService['baseCommentQuery']>,
    ) => ReturnType<EngagementService['baseCommentQuery']>,
  ): Promise<Page<Comment>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = scope(this.baseCommentQuery(viewerId)).limit(args.limit + 1);
    q = args.order === 'NEWEST' ? q.orderBy('c.id', 'desc') : q.orderBy('c.id', 'asc');
    if (cursor) q = q.where('c.id', args.order === 'NEWEST' ? '<' : '>', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrateComments(viewerId, page);
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }

  /** Comments that are live, clean, and by authors the viewer may see (blocks hide both ways). */
  private baseCommentQuery(viewerId: string | null) {
    return this.db
      .selectFrom('comments as c')
      .innerJoin('users as cu', 'cu.id', 'c.authorId')
      .innerJoin('posts as p', 'p.id', 'c.postId')
      .select(COMMENT_COLUMNS)
      .where('c.deletedAt', 'is', null)
      .where('c.moderationStatus', '=', 'CLEAN')
      .where(accountVisibleTo(viewerId, { authorId: 'c.author_id', authorStatus: 'cu.status' }));
  }

  private async commentRow(id: string): Promise<CommentRow> {
    const row = await this.baseCommentQueryNoViewer().where('c.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('COMMENT_NOT_FOUND');
    return row;
  }

  private baseCommentQueryNoViewer() {
    return this.db
      .selectFrom('comments as c')
      .innerJoin('posts as p', 'p.id', 'c.postId')
      .select(COMMENT_COLUMNS)
      .where('c.deletedAt', 'is', null);
  }

  /** A comment the viewer may act on (live, clean, author visible to them). Else COMMENT_NOT_FOUND. */
  private async visibleCommentRow(
    db: Db,
    viewerId: string | null,
    id: string,
  ): Promise<CommentRow> {
    const row = await db
      .selectFrom('comments as c')
      .innerJoin('users as cu', 'cu.id', 'c.authorId')
      .innerJoin('posts as p', 'p.id', 'c.postId')
      .select(COMMENT_COLUMNS)
      .where('c.id', '=', id)
      .where('c.deletedAt', 'is', null)
      .where('c.moderationStatus', '=', 'CLEAN')
      .where(accountVisibleTo(viewerId, { authorId: 'c.author_id', authorStatus: 'cu.status' }))
      .executeTakeFirst();
    if (!row) throw new AppError('COMMENT_NOT_FOUND');
    return row;
  }

  private async hydrateComments(
    viewerId: string | null,
    rows: readonly CommentRow[],
  ): Promise<Comment[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.authorId, ...(r.replyToUserId ? [r.replyToUserId] : [])])),
    ];
    const [users, reacted, usernames] = await Promise.all([
      this.directory.summaries(rows.map((r) => r.authorId)),
      viewerId
        ? this.db
            .selectFrom('commentReactions')
            .select('commentId')
            .where('userId', '=', viewerId)
            .where('commentId', 'in', ids)
            .execute()
        : Promise.resolve([]),
      this.db
        .selectFrom('profiles')
        .select(['userId', 'username'])
        .where('userId', 'in', userIds)
        .execute(),
    ]);
    const reactedSet = new Set(reacted.map((r) => r.commentId));
    const nameById = new Map(usernames.map((u) => [u.userId, u.username]));

    return rows.flatMap((r) => {
      const author = users.get(r.authorId);
      if (!author) return [];
      const replyName = r.replyToUserId ? nameById.get(r.replyToUserId) : undefined;
      return [
        {
          id: r.id,
          postId: r.postId,
          author,
          body: r.body,
          parentId: r.parentId,
          replyTo:
            r.replyToUserId && replyName ? { id: r.replyToUserId, username: replyName } : null,
          counts: { reactions: r.reactionCount, replies: r.replyCount },
          viewer: viewerId
            ? {
                reacted: reactedSet.has(r.id),
                isAuthor: r.authorId === viewerId,
                canDelete: r.authorId === viewerId || r.postAuthorId === viewerId,
              }
            : null,
          createdAt: r.createdAt.toISOString(),
        },
      ];
    });
  }

  /** Soft-deletes the comment and its replies (a thread goes with its root). Author or post author only. */
  async deleteComment(userId: string, commentId: string): Promise<void> {
    const row = await this.visibleCommentRow(this.db, userId, commentId);
    if (row.authorId !== userId && row.postAuthorId !== userId)
      throw new AppError('FORBIDDEN', {
        message: 'Only the comment author or the post author can delete a comment.',
      });
    await this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const affected = await trx
        .updateTable('comments')
        .set({ deletedAt: now })
        .where((eb) => eb.or([eb('id', '=', commentId), eb('parentId', '=', commentId)]))
        .where('deletedAt', 'is', null)
        .returning('id')
        .execute();
      if (affected.length > 0)
        await trx
          .deleteFrom('notifications')
          .where(
            'commentId',
            'in',
            affected.map((a) => a.id),
          )
          .execute();
    });
  }

  // ------------------------------------------------------------------ comment reactions

  async reactToComment(
    userId: string,
    commentId: string,
  ): Promise<{ reacted: true; reactionCount: number }> {
    const row = await this.visibleCommentRow(this.db, userId, commentId);
    await this.interactable(userId, row.postId);
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('commentReactions')
        .values({ commentId, userId })
        .onConflict((oc) => oc.doNothing())
        .returning('commentId')
        .executeTakeFirst();
      if (inserted) {
        await this.notifier.notify(
          {
            recipientId: row.authorId,
            type: 'COMMENT_REACTION',
            actorId: userId,
            postId: row.postId,
            commentId,
            dedupeKey: `comment_reaction:${commentId}:${userId}`,
          },
          trx,
        );
      }
      const c = await trx
        .selectFrom('comments')
        .select('reactionCount')
        .where('id', '=', commentId)
        .executeTakeFirstOrThrow();
      return { reacted: true as const, reactionCount: c.reactionCount };
    });
  }

  async unreactToComment(
    userId: string,
    commentId: string,
  ): Promise<{ reacted: false; reactionCount: number }> {
    return this.db.transaction().execute(async (trx) => {
      const c = await trx
        .selectFrom('comments')
        .select(['authorId', 'reactionCount'])
        .where('id', '=', commentId)
        .executeTakeFirst();
      const removed = await trx
        .deleteFrom('commentReactions')
        .where('commentId', '=', commentId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      if (c && Number(removed.numDeletedRows) > 0)
        await this.notifier.retract(
          { recipientId: c.authorId, dedupeKey: `comment_reaction:${commentId}:${userId}` },
          trx,
        );
      const after = await trx
        .selectFrom('comments')
        .select('reactionCount')
        .where('id', '=', commentId)
        .executeTakeFirst();
      return { reacted: false as const, reactionCount: after?.reactionCount ?? 0 };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async resolveMentions(db: Db, authorId: string, body: string): Promise<string[]> {
    const names = extractMentions(body);
    if (names.length === 0) return [];
    const users = await db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select('p.userId')
      .where('p.username', 'in', names)
      .where('u.status', '=', 'ACTIVE')
      .where('p.userId', '!=', authorId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('blocks as b')
              .select('b.blockerId')
              .where((e) =>
                e.or([
                  e.and([
                    e('b.blockerId', '=', authorId),
                    e('b.blockedId', '=', eb.ref('p.userId')),
                  ]),
                  e.and([
                    e('b.blockerId', '=', eb.ref('p.userId')),
                    e('b.blockedId', '=', authorId),
                  ]),
                ]),
              ),
          ),
        ),
      )
      .execute();
    return users.map((u) => u.userId);
  }
}
