import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import type { ModerationFlagSink } from '../../platform/ports/content-moderation';

/** Files automated moderation hits in the same queue as user reports (source AUTOMATED). */
export class DbFlagSink implements ModerationFlagSink {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async flag(input: Parameters<ModerationFlagSink['flag']>[0]): Promise<void> {
    try {
      await this.db
        .insertInto('reports')
        .values({
          source: 'AUTOMATED',
          reporterId: null,
          targetType: input.targetType,
          targetPostId: input.targetType === 'POST' ? input.targetId : null,
          targetCommentId: input.targetType === 'COMMENT' ? input.targetId : null,
          targetUserId: input.targetType === 'USER' ? input.targetId : null,
          reason: 'OTHER',
          details: input.reason.slice(0, 1000),
          snapshot: JSON.stringify({ text: input.text.slice(0, 2400) }),
          createdAt: this.clock.now(),
        })
        // One open automated report per target: re-flagging an edit does not pile up.
        .onConflict((oc) => oc.doNothing())
        .execute();
    } catch (err) {
      // Flagging is best effort. The content is already stored; never fail the user's request
      // because the moderation queue could not be written (e.g. the target was just deleted).
      this.logger.warn({ err, targetType: input.targetType }, 'could not file an automated report');
    }
  }
}
