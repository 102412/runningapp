import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db/client';
import { jobSpec, type JobQueue } from '../platform/jobs/queue';
import { MediaDeleteObjectsJob } from '../modules/media/service';

export const PurgeDueAccountsJob = jobSpec('accounts.purge_due', z.object({}), { maxAttempts: 3 });

const BATCH = 20;
const KEY_CHUNK = 500;

/**
 * Permanent account deletion. A user who asked to delete their account is first locked out for a
 * grace period (they can cancel); once it ends this job removes the user row, and every table that
 * hangs off it cascades. Stored files are not covered by foreign keys, so every object key (media
 * originals and variants, data exports) is queued for deletion IN THE SAME TRANSACTION as the
 * row - if the delete commits, the files are guaranteed to be cleaned up; if it rolls back, nothing is.
 *
 * Reports this person filed stay in the moderation queue (their reporter id is nulled), and the
 * append-only moderation audit trail keeps only opaque ids, so it can outlive the account.
 */
export class AccountPurger {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobQueue,
    private readonly logger: FastifyBaseLogger,
  ) {}

  readonly handlePurgeDue = async (): Promise<void> => {
    const due = await this.db
      .selectFrom('users')
      .select('id')
      .where('status', '=', 'PENDING_DELETION')
      .where('deletionScheduledFor', '<=', this.clock.now())
      .orderBy('deletionScheduledFor')
      .limit(BATCH)
      .execute();
    for (const { id } of due) {
      try {
        if (await this.purge(id)) this.logger.info({ userId: id }, 'account purged');
      } catch (err) {
        // One bad account must not block the rest; it is retried on the next run.
        this.logger.error({ err, userId: id }, 'account purge failed');
      }
    }
  };

  /** Returns false when the account was no longer due (cancelled meanwhile). */
  async purge(userId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .where('status', '=', 'PENDING_DELETION')
        .where('deletionScheduledFor', '<=', this.clock.now())
        .forUpdate()
        .executeTakeFirst();
      if (!user) return false;

      const media = await trx
        .selectFrom('mediaAssets')
        .select(['id', 'storageKey'])
        .where('ownerId', '=', userId)
        .execute();
      const variants =
        media.length === 0
          ? []
          : await trx
              .selectFrom('mediaVariants')
              .select('storageKey')
              .where(
                'mediaId',
                'in',
                media.map((m) => m.id),
              )
              .execute();
      const exports = await trx
        .selectFrom('dataExports')
        .select('storageKey')
        .where('userId', '=', userId)
        .where('storageKey', 'is not', null)
        .execute();
      const keys = [
        ...media.map((m) => m.storageKey),
        ...variants.map((v) => v.storageKey),
        ...exports.flatMap((e) => (e.storageKey ? [e.storageKey] : [])),
      ];
      for (let i = 0; i < keys.length; i += KEY_CHUNK) {
        await this.jobs.enqueue(
          MediaDeleteObjectsJob,
          { keys: keys.slice(i, i + KEY_CHUNK) },
          { db: trx },
        );
      }

      // post_media -> media_assets is RESTRICT (a post's media cannot be pulled out from under it),
      // so detach the user's media from their posts before the cascade removes both.
      await trx
        .deleteFrom('postMedia')
        .where('postId', 'in', trx.selectFrom('posts').select('id').where('authorId', '=', userId))
        .execute();
      await trx.deleteFrom('users').where('id', '=', userId).execute();
      return true;
    });
  }
}
