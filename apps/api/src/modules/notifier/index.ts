import { z } from 'zod';
import type { NotificationType } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { jobSpec, type JobQueue } from '../../platform/jobs/queue';

export const PushNotificationJob = jobSpec(
  'notifications.push',
  z.object({ notificationId: z.uuid() }),
  { maxAttempts: 5 },
);

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
 * Write side of notifications. Deliberately tiny so any module (social, engagement, posts,
 * moderation...) can emit notifications without importing the notifications read API. Callers pass
 * their transaction so a notification exists iff the triggering change commits.
 */
export interface Notifier {
  notify(notification: NewNotification, db?: Db): Promise<void>;
  retract(retraction: RetractNotification, db?: Db): Promise<void>;
}

export class DbNotifier implements Notifier {
  constructor(
    private readonly defaultDb: Db,
    private readonly jobs: JobQueue,
  ) {}

  async notify(n: NewNotification, db: Db = this.defaultDb): Promise<void> {
    // Never notify people about their own actions.
    if (n.actorId && n.actorId === n.recipientId) return;

    // Preferences: "in-app off" suppresses the notification entirely (and so any push for it).
    const pref = await db
      .selectFrom('notificationPreferences')
      .select(['inApp', 'push'])
      .where('userId', '=', n.recipientId)
      .where('type', '=', n.type)
      .executeTakeFirst();
    if (pref && !pref.inApp) return;

    const inserted = await db
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
      .returning('id')
      .executeTakeFirst();
    if (!inserted || pref?.push === false) return;

    // Only queue delivery work if the recipient has somewhere to deliver to.
    const device = await db
      .selectFrom('devices')
      .select('id')
      .where('userId', '=', n.recipientId)
      .where('pushToken', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    if (device)
      await this.jobs.enqueue(PushNotificationJob, { notificationId: inserted.id }, { db });
  }

  async retract(r: RetractNotification, db: Db = this.defaultDb): Promise<void> {
    await db
      .deleteFrom('notifications')
      .where('recipientId', '=', r.recipientId)
      .where('dedupeKey', '=', r.dedupeKey)
      .execute();
  }
}
