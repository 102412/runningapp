import { sql } from 'kysely';
import { z } from 'zod';
import {
  NotificationType,
  type DevicePlatform,
  type Notification,
  type PushProviderName,
} from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import type { PushProvider } from '../../platform/ports/push';
import type { MediaService } from '../media/service';
import { postReadableBy } from '../posts/visibility';
import { accountVisibleTo } from '../social/visibility';
import type { UserDirectory } from '../users/directory';

const IdCursor = z.object({ id: z.uuid() });
const UNREAD_CAP = 100;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly directory: UserDirectory,
    private readonly media: MediaService,
    private readonly push: PushProvider,
  ) {}

  /**
   * Visible notifications for a user: not about people they blocked (or who blocked them), not
   * about posts/comments that are gone, hidden, or no longer in their audience.
   */
  private visibleBase(userId: string) {
    return this.db
      .selectFrom('notifications as n')
      .leftJoin('users as actor', 'actor.id', 'n.actorId')
      .leftJoin('posts as p', 'p.id', 'n.postId')
      .leftJoin('users as au', 'au.id', 'p.authorId')
      .leftJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .leftJoin('comments as c', 'c.id', 'n.commentId')
      .where('n.recipientId', '=', userId)
      .where(
        sql<boolean>`(n.actor_id is null or ${accountVisibleTo(userId, { authorId: 'n.actor_id', authorStatus: 'actor.status' })})`,
      )
      .where(sql<boolean>`(n.post_id is null or ${postReadableBy(userId)})`)
      .where(
        // A moderation notice must stay visible to the author even though the comment it is
        // about has just been hidden or removed.
        sql<boolean>`(n.comment_id is null or n.type = 'MODERATION_ACTION' or (c.deleted_at is null and c.moderation_status = 'CLEAN'))`,
      );
  }

  async list(
    userId: string,
    args: { limit: number; cursor?: string | undefined; unreadOnly?: boolean | undefined },
  ): Promise<Page<Notification>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.visibleBase(userId)
      .select([
        'n.id',
        'n.type',
        'n.actorId',
        'n.postId',
        'n.commentId',
        'n.data',
        'n.readAt',
        'n.createdAt',
        'p.format as postFormat',
        'p.caption as postCaption',
        'c.body as commentBody',
      ])
      .orderBy('n.id', 'desc')
      .limit(args.limit + 1);
    if (args.unreadOnly) q = q.where('n.readAt', 'is', null);
    if (cursor) q = q.where('n.id', '<', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);

    const actorIds = page.flatMap((n) => (n.actorId ? [n.actorId] : []));
    const postIds = [...new Set(page.flatMap((n) => (n.postId ? [n.postId] : [])))];
    const requestActors = page
      .filter((n) => n.type === 'FOLLOW_REQUEST' && n.actorId)
      .map((n) => n.actorId as string);

    const [actors, firstMedia, requests] = await Promise.all([
      this.directory.summaries(actorIds),
      postIds.length > 0
        ? this.db
            .selectFrom('postMedia')
            .select(['postId', 'mediaId', 'position'])
            .where('postId', 'in', postIds)
            .orderBy('position')
            .execute()
        : Promise.resolve([]),
      requestActors.length > 0
        ? this.db
            .selectFrom('followRequests')
            .select(['id', 'requesterId'])
            .where('targetId', '=', userId)
            .where('requesterId', 'in', requestActors)
            .execute()
        : Promise.resolve([]),
    ]);
    const firstByPost = new Map<string, string>();
    for (const m of firstMedia)
      if (!firstByPost.has(m.postId)) firstByPost.set(m.postId, m.mediaId);
    const mediaViews = await this.media.viewsByIds([...firstByPost.values()]);
    const requestByActor = new Map(requests.map((r) => [r.requesterId, r.id]));

    const items: Notification[] = page.map((n) => {
      const thumb = n.postId
        ? (mediaViews.get(firstByPost.get(n.postId) ?? '')?.urls.thumbnail ?? null)
        : null;
      return {
        id: n.id,
        type: n.type,
        actor: n.actorId ? (actors.get(n.actorId) ?? null) : null,
        post:
          n.postId && n.postFormat
            ? {
                id: n.postId,
                format: n.postFormat,
                thumbnailUrl: thumb,
                captionExcerpt: (n.postCaption ?? '').slice(0, 100),
              }
            : null,
        comment: n.commentId
          ? { id: n.commentId, excerpt: (n.commentBody ?? '').slice(0, 100) }
          : null,
        followRequestId:
          n.type === 'FOLLOW_REQUEST' && n.actorId ? (requestByActor.get(n.actorId) ?? null) : null,
        data: n.data as Notification['data'],
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }

  /** Unread notifications the user can actually see, capped (badges show "99+"). */
  async unreadCount(userId: string): Promise<number> {
    const rows = await this.visibleBase(userId)
      .select('n.id')
      .where('n.readAt', 'is', null)
      .limit(UNREAD_CAP)
      .execute();
    return rows.length;
  }

  async markRead(
    userId: string,
    target: { ids?: string[] | undefined; all?: boolean | undefined },
  ): Promise<number> {
    let q = this.db
      .updateTable('notifications')
      .set({ readAt: new Date() })
      .where('recipientId', '=', userId)
      .where('readAt', 'is', null);
    if (target.ids) q = q.where('id', 'in', target.ids); // recipient filter above: cannot touch others' notifications
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  // ------------------------------------------------------------------ preferences

  async getPreferences(userId: string) {
    const rows = await this.db
      .selectFrom('notificationPreferences')
      .select(['type', 'inApp', 'push'])
      .where('userId', '=', userId)
      .execute();
    const byType = new Map(rows.map((r) => [r.type, r]));
    return NotificationType.values.map((type) => ({
      type,
      inApp: byType.get(type)?.inApp ?? true,
      push: byType.get(type)?.push ?? true,
    }));
  }

  async setPreferences(
    userId: string,
    items: Array<{ type: Notification['type']; inApp: boolean; push: boolean }>,
  ) {
    const latest = new Map(items.map((i) => [i.type, i]));
    await this.db.transaction().execute(async (trx) => {
      for (const i of latest.values()) {
        await trx
          .insertInto('notificationPreferences')
          .values({ userId, type: i.type, inApp: i.inApp, push: i.push && i.inApp })
          .onConflict((oc) =>
            oc
              .columns(['userId', 'type'])
              .doUpdateSet({ inApp: i.inApp, push: i.push && i.inApp, updatedAt: new Date() }),
          )
          .execute();
      }
    });
    return this.getPreferences(userId);
  }

  // ------------------------------------------------------------------ push tokens

  /** Attaches a push token to the device behind the current session (creating the device if needed). */
  async registerPushToken(
    userId: string,
    sessionId: string,
    input: {
      provider: PushProviderName;
      token: string;
      installId?: string | undefined;
      platform?: DevicePlatform | undefined;
    },
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const session = await trx
        .selectFrom('sessions')
        .select('deviceId')
        .where('id', '=', sessionId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      let deviceId = session?.deviceId ?? null;
      if (!deviceId) {
        if (!input.installId || !input.platform) {
          throw new AppError('VALIDATION_FAILED', {
            details: [
              {
                path: 'installId',
                message: 'This session has no device. Send installId and platform.',
              },
            ],
          });
        }
        const device = await trx
          .insertInto('devices')
          .values({ userId, installId: input.installId, platform: input.platform })
          .onConflict((oc) =>
            oc
              .columns(['userId', 'installId'])
              .doUpdateSet({ platform: input.platform as DevicePlatform, lastSeenAt: new Date() }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        deviceId = device.id;
        await trx.updateTable('sessions').set({ deviceId }).where('id', '=', sessionId).execute();
      }
      // A token belongs to exactly one device: move it if another account/device held it before.
      await trx
        .updateTable('devices')
        .set({ pushProvider: null, pushToken: null })
        .where('pushProvider', '=', input.provider)
        .where('pushToken', '=', input.token)
        .where('id', '!=', deviceId)
        .execute();
      await trx
        .updateTable('devices')
        .set({
          pushProvider: input.provider,
          pushToken: input.token,
          pushTokenUpdatedAt: new Date(),
        })
        .where('id', '=', deviceId)
        .where('userId', '=', userId)
        .execute();
    });
  }

  async removePushToken(userId: string, sessionId: string): Promise<void> {
    const session = await this.db
      .selectFrom('sessions')
      .select('deviceId')
      .where('id', '=', sessionId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!session?.deviceId) return;
    await this.db
      .updateTable('devices')
      .set({ pushProvider: null, pushToken: null, pushTokenUpdatedAt: null })
      .where('id', '=', session.deviceId)
      .execute();
  }

  // ------------------------------------------------------------------ push delivery (job handler)

  readonly handlePush = async (payload: { notificationId: string }): Promise<void> => {
    const n = await this.db
      .selectFrom('notifications as n')
      .leftJoin('profiles as ap', 'ap.userId', 'n.actorId')
      .select([
        'n.id',
        'n.recipientId',
        'n.type',
        'n.postId',
        'n.commentId',
        'n.readAt',
        'n.data',
        'ap.displayName as actorName',
      ])
      .where('n.id', '=', payload.notificationId)
      .executeTakeFirst();
    if (!n || n.readAt) return; // gone, retracted, or already seen in-app
    const devices = await this.db
      .selectFrom('devices')
      .select(['id', 'pushProvider', 'pushToken'])
      .where('userId', '=', n.recipientId)
      .where('pushToken', 'is not', null)
      .execute();
    const { title, body } = renderPush(
      n.type,
      n.actorName ?? 'Someone',
      n.data as Record<string, unknown>,
    );
    const data: Record<string, string> = {
      type: n.type,
      notificationId: n.id,
      ...(n.postId ? { postId: n.postId } : {}),
      ...(n.commentId ? { commentId: n.commentId } : {}),
    };
    for (const d of devices) {
      if (!d.pushProvider || !d.pushToken) continue;
      const result = await this.push.send({
        provider: d.pushProvider,
        token: d.pushToken,
        title,
        body,
        data,
      });
      if (!result.ok && result.invalidToken) {
        await this.db
          .updateTable('devices')
          .set({ pushProvider: null, pushToken: null })
          .where('id', '=', d.id)
          .execute();
      }
    }
  };
}

/** Human-readable push text. Deliberately short and free of private content beyond what the app shows. */
export function renderPush(
  type: Notification['type'],
  actor: string,
  data: Record<string, unknown>,
): { title: string; body: string } {
  const excerpt = typeof data.excerpt === 'string' ? `: ${data.excerpt}` : '';
  switch (type) {
    case 'NEW_FOLLOWER':
      return { title: 'New follower', body: `${actor} started following you` };
    case 'FOLLOW_REQUEST':
      return { title: 'Follow request', body: `${actor} wants to follow you` };
    case 'FOLLOW_ACCEPTED':
      return { title: 'Request accepted', body: `${actor} accepted your follow request` };
    case 'POST_REACTION':
      return { title: 'New reaction', body: `${actor} reacted to your post` };
    case 'POST_COMMENT':
      return { title: 'New comment', body: `${actor} commented${excerpt}` };
    case 'COMMENT_REPLY':
      return { title: 'New reply', body: `${actor} replied${excerpt}` };
    case 'COMMENT_REACTION':
      return { title: 'New like', body: `${actor} liked your comment` };
    case 'MENTION_POST':
      return { title: 'You were mentioned', body: `${actor} mentioned you in a post` };
    case 'MENTION_COMMENT':
      return { title: 'You were mentioned', body: `${actor} mentioned you${excerpt}` };
    case 'POST_PUBLISHED':
      return {
        title: 'Your post is live',
        body: 'Your post finished processing and is now published',
      };
    case 'POST_PUBLISH_FAILED':
      return { title: 'Post problem', body: 'Something in your post could not be processed' };
    case 'MODERATION_ACTION':
      return { title: 'Account notice', body: 'We took action on some of your content' };
  }
}
