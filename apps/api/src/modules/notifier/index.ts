import type { NotificationType } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';

export interface NewNotification {
  recipientId: string;
  type: NotificationType;
  actorId?: string | null;
  postId?: string | null;
  commentId?: string | null;
  data?: Record<string, string | number | boolean | null>;
  /** Natural key; re-sending the same key for the same recipient is a no-op. */
  dedupeKey?: string;
}

export interface RetractNotification {
  recipientId: string;
  dedupeKey: string;
}

/**
 * Write side of notifications. Deliberately tiny and dependency-free so any module (social,
 * engagement, moderation...) can emit notifications without importing the notifications read
 * API. Callers pass their transaction so a notification exists iff the triggering change commits.
 */
export interface Notifier {
  notify(notification: NewNotification, db?: Db): Promise<void>;
  retract(retraction: RetractNotification, db?: Db): Promise<void>;
}

export class DbNotifier implements Notifier {
  constructor(private readonly defaultDb: Db) {}

  async notify(n: NewNotification, db: Db = this.defaultDb): Promise<void> {
    // Never notify people about their own actions.
    if (n.actorId && n.actorId === n.recipientId) return;
    await db
      .insertInto('notifications')
      .values({
        recipientId: n.recipientId,
        type: n.type,
        actorId: n.actorId ?? null,
        postId: n.postId ?? null,
        commentId: n.commentId ?? null,
        data: JSON.stringify(n.data ?? {}),
        dedupeKey: n.dedupeKey ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async retract(r: RetractNotification, db: Db = this.defaultDb): Promise<void> {
    await db
      .deleteFrom('notifications')
      .where('recipientId', '=', r.recipientId)
      .where('dedupeKey', '=', r.dedupeKey)
      .execute();
  }
}
