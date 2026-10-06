import { sql } from 'kysely';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { NIL_UUID, uuidv7Floor } from '../../platform/ids';
import { jobSpec } from '../../platform/jobs/queue';
import { AFFINITY_LOOKBACK_DAYS, computeAffinities, type AffinityEvent } from './affinities';

/**
 * `settleSeconds`: events younger than this are left for the next run. Event ids are time-ordered
 * and the jobs below advance a watermark over them, so a row that commits after a newer id has
 * been processed would be skipped forever. Events are inserted in sub-second transactions, which
 * the settle window comfortably covers.
 */
const settleSchema = z.object({ settleSeconds: z.number().int().min(0).max(3600).default(60) });

export const RollupPostStatsJob = jobSpec('feed.rollup_post_stats', settleSchema, {
  maxAttempts: 3,
});
export const RefreshAffinitiesJob = jobSpec('feed.refresh_affinities', settleSchema, {
  maxAttempts: 3,
});
export const PurgeAnalyticsJob = jobSpec('feed.purge_analytics', z.object({}), { maxAttempts: 3 });

const BATCH = 5000;
const MAX_BATCHES_PER_RUN = 20;
const AFFINITY_EVENT_LIMIT = 5000;
/** A single WATCH_TIME event counts for at most this long (client-reported, so bounded). */
const WATCH_TIME_CAP_MS = 10 * 60_000;
const PURGE_CHUNK = 5000;
const DAY_MS = 86_400_000;

export class FeedAnalytics {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: FastifyBaseLogger,
  ) {}

  // ------------------------------------------------------------------ post_stats rollup

  readonly handleRollup = async (payload: { settleSeconds: number }): Promise<void> => {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const processed = await this.rollupBatch(payload.settleSeconds);
      if (processed < BATCH) return;
    }
  };

  /**
   * Folds one batch of new events into `post_stats`, exactly once: the counters and the watermark
   * move in one transaction, and the watermark row is locked so concurrent workers serialise.
   * Anti-abuse: each user counts once per post per event type per batch, the post author's own
   * events are ignored, and watch time per event is capped. Returns the events consumed.
   */
  async rollupBatch(settleSeconds: number): Promise<number> {
    const boundary = this.settledBoundary(settleSeconds);
    return this.db.transaction().execute(async (trx) => {
      const wm = await this.lockWatermark(trx, 'post_stats');
      const ids = await trx
        .selectFrom('feedEvents')
        .select('id')
        .where('id', '>', wm)
        .where('id', '<', boundary)
        .orderBy('id')
        .limit(BATCH)
        .execute();
      const upper = ids[ids.length - 1]?.id;
      if (!upper) return 0;

      await sql`
        insert into post_stats
          (post_id, impressions, video_starts, video_completes, skips, not_interested, watch_time_ms, updated_at)
        select e.post_id,
               count(distinct e.user_id) filter (where e.event_type = 'IMPRESSION'),
               count(distinct e.user_id) filter (where e.event_type = 'VIDEO_START'),
               count(distinct e.user_id) filter (where e.event_type = 'VIDEO_COMPLETE'),
               count(distinct e.user_id) filter (where e.event_type = 'SKIP'),
               count(distinct e.user_id) filter (where e.event_type = 'NOT_INTERESTED'),
               coalesce(sum(least(e.value_ms, ${WATCH_TIME_CAP_MS})) filter (where e.event_type = 'WATCH_TIME'), 0),
               ${this.clock.now()}
          from feed_events e
          join posts p on p.id = e.post_id
         where e.id > ${wm}::uuid and e.id <= ${upper}::uuid
           and e.user_id <> p.author_id
           and e.event_type in ('IMPRESSION','VIDEO_START','VIDEO_COMPLETE','WATCH_TIME','SKIP','NOT_INTERESTED')
         group by e.post_id
        on conflict (post_id) do update set
          impressions     = post_stats.impressions     + excluded.impressions,
          video_starts    = post_stats.video_starts    + excluded.video_starts,
          video_completes = post_stats.video_completes + excluded.video_completes,
          skips           = post_stats.skips           + excluded.skips,
          not_interested  = post_stats.not_interested  + excluded.not_interested,
          watch_time_ms   = post_stats.watch_time_ms   + excluded.watch_time_ms,
          updated_at      = excluded.updated_at`.execute(trx);

      await this.setWatermark(trx, 'post_stats', upper);
      return ids.length;
    });
  }

  // ------------------------------------------------------------------ affinities

  readonly handleAffinities = async (payload: { settleSeconds: number }): Promise<void> => {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const processed = await this.affinityBatch(payload.settleSeconds);
      if (processed < BATCH) return;
    }
  };

  /**
   * Recomputes the taste profile of every user who produced events since the watermark.
   * Idempotent by construction (a full recompute from the last 60 days), so a crash between users
   * just means the batch is redone.
   */
  async affinityBatch(settleSeconds: number): Promise<number> {
    const boundary = this.settledBoundary(settleSeconds);
    const wm = await this.readWatermark(this.db, 'affinities');
    const rows = await this.db
      .selectFrom('feedEvents')
      .select(['id', 'userId'])
      .where('id', '>', wm)
      .where('id', '<', boundary)
      .orderBy('id')
      .limit(BATCH)
      .execute();
    const upper = rows[rows.length - 1]?.id;
    if (!upper) return 0;

    for (const userId of new Set(rows.map((r) => r.userId))) {
      try {
        await this.refreshUser(userId);
      } catch (err) {
        this.logger.error({ err, userId }, 'affinity refresh failed for user');
        throw err; // retry the whole batch; refreshUser is idempotent
      }
    }
    await this.setWatermark(this.db, 'affinities', upper);
    return rows.length;
  }

  /** Full recompute for one user (also used directly by tests and by a future backfill). */
  async refreshUser(userId: string): Promise<void> {
    const settings = await this.db
      .selectFrom('userSettings')
      .select('personalizationEnabled')
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!settings?.personalizationEnabled) {
      await this.db.deleteFrom('userAffinities').where('userId', '=', userId).execute();
      return;
    }

    const now = this.clock.now();
    const since = new Date(now.getTime() - AFFINITY_LOOKBACK_DAYS * DAY_MS);
    const rows = await this.db
      .selectFrom('feedEvents as e')
      .leftJoin('posts as p', 'p.id', 'e.postId')
      .leftJoin('activities as a', 'a.id', 'p.activityId')
      .select([
        'e.eventType',
        'e.valueMs',
        'e.createdAt',
        'e.postId',
        'e.topic',
        'e.subjectUserId',
        'p.authorId',
        'p.format',
        'a.sportKey',
      ])
      .where('e.userId', '=', userId)
      .where('e.createdAt', '>', since)
      // Interacting with your own posts says nothing about your taste.
      .where((eb) => eb.or([eb('p.authorId', 'is', null), eb('p.authorId', '!=', userId)]))
      .orderBy('e.createdAt', 'desc')
      .limit(AFFINITY_EVENT_LIMIT)
      .execute();

    const postIds = [...new Set(rows.flatMap((r) => (r.postId ? [r.postId] : [])))];
    const topicRows =
      postIds.length === 0
        ? []
        : await this.db
            .selectFrom('postTopics as pt')
            .innerJoin('topics as t', 't.id', 'pt.topicId')
            .select(['pt.postId', 't.slug'])
            .where('pt.postId', 'in', postIds)
            .execute();
    const topicsByPost = new Map<string, string[]>();
    for (const t of topicRows)
      topicsByPost.set(t.postId, [...(topicsByPost.get(t.postId) ?? []), t.slug]);

    const events: AffinityEvent[] = rows.map((r) => ({
      type: r.eventType,
      valueMs: r.valueMs,
      createdAt: r.createdAt,
      creatorId: r.authorId ?? r.subjectUserId,
      sportKey: r.sportKey,
      format: r.format,
      topics: [
        ...(r.postId ? (topicsByPost.get(r.postId) ?? []) : []),
        ...(r.topic ? [r.topic] : []),
      ],
    }));
    const scores = computeAffinities(events, now);

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('userAffinities').where('userId', '=', userId).execute();
      if (scores.length > 0) {
        await trx
          .insertInto('userAffinities')
          .values(scores.map((s) => ({ userId, ...s, updatedAt: now })))
          .execute();
      }
    });
  }

  // ------------------------------------------------------------------ retention

  readonly handlePurge = async (): Promise<void> => {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.config.ANALYTICS_RETENTION_DAYS * DAY_MS);
    await this.purge('feed_snapshots', 'expires_at', now);
    await this.purge('feed_events', 'created_at', cutoff);
    // recommendation_events cascade with their request.
    await this.purge('feed_requests', 'created_at', cutoff);
  };

  private async purge(table: string, column: string, before: Date): Promise<void> {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const res = await sql`
        delete from ${sql.table(table)}
         where id in (select id from ${sql.table(table)} where ${sql.ref(column)} < ${before} limit ${PURGE_CHUNK})`.execute(
        this.db,
      );
      if (Number(res.numAffectedRows ?? 0) < PURGE_CHUNK) return;
    }
  }

  // ------------------------------------------------------------------ watermarks

  private settledBoundary(settleSeconds: number): string {
    return uuidv7Floor(this.clock.now().getTime() - settleSeconds * 1000);
  }

  private async readWatermark(db: Db, name: string): Promise<string> {
    const row = await db
      .selectFrom('analyticsWatermarks')
      .select('lastEventId')
      .where('name', '=', name)
      .executeTakeFirst();
    return row?.lastEventId ?? NIL_UUID;
  }

  /** Creates the row on first use and locks it for the rest of the transaction. */
  private async lockWatermark(trx: Db, name: string): Promise<string> {
    await trx
      .insertInto('analyticsWatermarks')
      .values({ name, lastEventId: null })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const row = await trx
      .selectFrom('analyticsWatermarks')
      .select('lastEventId')
      .where('name', '=', name)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return row.lastEventId ?? NIL_UUID;
  }

  private async setWatermark(db: Db, name: string, lastEventId: string): Promise<void> {
    await db
      .insertInto('analyticsWatermarks')
      .values({ name, lastEventId, updatedAt: this.clock.now() })
      .onConflict((oc) =>
        oc
          .column('name')
          .doUpdateSet({ lastEventId, updatedAt: this.clock.now() })
          // never move backwards (a slow worker finishing after a faster one)
          .where(
            sql<boolean>`analytics_watermarks.last_event_id is null or analytics_watermarks.last_event_id < ${lastEventId}::uuid`,
          ),
      )
      .execute();
  }
}
