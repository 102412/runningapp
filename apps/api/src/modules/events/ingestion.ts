import type { ClientEvent, EventBatchResult } from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { postReadableBy } from '../posts/visibility';
import { accountVisibleTo } from '../social/visibility';

const CLIENT_TS_MAX_AGE_MS = 7 * 24 * 3_600_000;
const CLIENT_TS_MAX_FUTURE_MS = 3_600_000;

/**
 * Accepts batches of client-observed events (impressions, watch time, "not interested"...).
 *
 *  - Idempotent: events are keyed by (user, clientGeneratedEventId), so retries never double-count.
 *  - Authorised: an event may only reference a post/profile the user can see right now; anything
 *    else is reported as rejected (never stored), which reveals nothing the user couldn't learn
 *    from the content endpoints themselves.
 *  - Privacy: with personalization switched off, behavioural events are accepted and DISCARDED.
 *    The one exception is NOT_INTERESTED, which is a direct "hide this" control, not profiling.
 *  - Untrusted: attribution to someone else's feed request is dropped and implausible client
 *    timestamps are ignored rather than trusted.
 */
export class EventIngestionService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async ingest(userId: string, events: readonly ClientEvent[]): Promise<EventBatchResult> {
    const settings = await this.db
      .selectFrom('userSettings')
      .select('personalizationEnabled')
      .where('userId', '=', userId)
      .executeTakeFirst();
    const personalized = settings?.personalizationEnabled ?? true;

    // De-duplicate within the batch itself (first occurrence wins).
    const seen = new Set<string>();
    let duplicates = 0;
    const unique: ClientEvent[] = [];
    for (const e of events) {
      if (seen.has(e.eventId)) duplicates += 1;
      else {
        seen.add(e.eventId);
        unique.push(e);
      }
    }

    const postIds = [...new Set(unique.flatMap((e) => (e.postId ? [e.postId] : [])))];
    const profileIds = [
      ...new Set(unique.flatMap((e) => (e.subjectUserId ? [e.subjectUserId] : []))),
    ];
    const requestIds = [
      ...new Set(unique.flatMap((e) => (e.feedRequestId ? [e.feedRequestId] : []))),
    ];

    const [posts, profiles, requests] = await Promise.all([
      postIds.length === 0
        ? []
        : this.db
            .selectFrom('posts as p')
            .innerJoin('users as au', 'au.id', 'p.authorId')
            .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
            .select(['p.id', 'p.activityId'])
            .where('p.id', 'in', postIds)
            .where(postReadableBy(userId))
            .execute(),
      profileIds.length === 0
        ? []
        : this.db
            .selectFrom('users as u')
            .select('u.id')
            .where('u.id', 'in', profileIds)
            .where(accountVisibleTo(userId, { authorId: 'u.id', authorStatus: 'u.status' }))
            .execute(),
      requestIds.length === 0
        ? []
        : this.db
            .selectFrom('feedRequests')
            .select('id')
            .where('userId', '=', userId)
            .where('id', 'in', requestIds)
            .execute(),
    ]);
    const readablePosts = new Map(posts.map((p) => [p.id, p.activityId]));
    const visibleProfiles = new Set(profiles.map((p) => p.id));
    const ownRequests = new Set(requests.map((r) => r.id));

    const now = this.clock.now().getTime();
    const rejected: EventBatchResult['rejected'] = [];
    let discarded = 0;
    const rows = [];
    for (const e of unique) {
      if (e.postId && !readablePosts.has(e.postId)) {
        rejected.push({ eventId: e.eventId, code: 'POST_NOT_FOUND' });
        continue;
      }
      if (e.subjectUserId && !visibleProfiles.has(e.subjectUserId)) {
        rejected.push({ eventId: e.eventId, code: 'USER_NOT_FOUND' });
        continue;
      }
      if (!personalized && e.type !== 'NOT_INTERESTED') {
        discarded += 1;
        continue;
      }
      const ts = e.clientTs ? Date.parse(e.clientTs) : NaN;
      const plausible =
        Number.isFinite(ts) &&
        ts >= now - CLIENT_TS_MAX_AGE_MS &&
        ts <= now + CLIENT_TS_MAX_FUTURE_MS;
      rows.push({
        eventId: e.eventId,
        userId,
        eventType: e.type,
        origin: 'CLIENT',
        postId: e.postId ?? null,
        activityId: e.postId ? (readablePosts.get(e.postId) ?? null) : null,
        subjectUserId: e.subjectUserId ?? null,
        topic: e.topic ? e.topic.toLowerCase() : null,
        surface: e.surface ?? null,
        feedRequestId: e.feedRequestId && ownRequests.has(e.feedRequestId) ? e.feedRequestId : null,
        position: e.position ?? null,
        valueMs: e.valueMs ?? null,
        clientTs: plausible ? new Date(ts) : null,
      });
    }

    let stored = 0;
    if (rows.length > 0) {
      const inserted = await this.db
        .insertInto('feedEvents')
        .values(rows)
        .onConflict((oc) => oc.columns(['userId', 'eventId']).doNothing())
        .returning('eventId')
        .execute();
      stored = inserted.length;
      duplicates += rows.length - stored;
    }
    return { accepted: stored + discarded, duplicates, rejected };
  }
}
