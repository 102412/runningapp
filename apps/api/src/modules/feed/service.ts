import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import {
  FeedItemReason,
  type FeedItem,
  type FeedPage,
  type FeedSurface,
  type Post,
} from '@runningapp/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import { uuidv7 } from '../../platform/ids';
import { POST_COLUMNS, type PostHydrator } from '../posts/hydrator';
import { postListableBy } from '../posts/visibility';
import { viewerFollows } from '../social/visibility';
import type { AgePolicy } from '../users/age-policy';
import {
  ALGORITHM_VERSIONS,
  EXPLORE_DIVERSITY,
  HOME_DIVERSITY,
  diversify,
  interleave,
  rank,
  type Candidate,
  type ScoredCandidate,
  type Taste,
} from './ranking';

const FollowingCursor = z.object({ t: z.string(), id: z.uuid() });
const SnapshotCursor = z.object({ s: z.uuid(), o: z.number().int().min(0) });
const SnapshotItems = z.array(
  z.object({
    p: z.uuid(),
    s: z.number(),
    r: FeedItemReason.schema,
    f: z.record(z.string(), z.number()),
  }),
);
type SnapshotItem = z.infer<typeof SnapshotItems>[number];

/** Candidate pool sizes and windows. Candidate generation is deliberately simple SQL (see docs/FEED.md). */
const FOLLOWED_POOL = 150;
const TRENDING_POOL = 150;
const FRESH_POOL = 100;
const SPORT_POOL = 100;
const FOLLOWED_WINDOW_DAYS = 14;
const DISCOVERY_WINDOW_DAYS = 7;
const SPORT_WINDOW_DAYS = 14;
const SEEN_LOOKBACK_DAYS = 7;
/** Home shows one discovery item after every (n-1) items from people you follow. */
const HOME_DISCOVERY_EVERY = 4;

const EXPLICIT_SPORT_AFFINITY = { PARTICIPANT: 0.6, FOLLOWER: 0.4, PRIMARY: 0.8 } as const;

type RankedSurface = 'HOME' | 'EXPLORE';

interface ViewerContext {
  personalized: boolean;
  isMinor: boolean;
  sportKeys: string[];
  taste: Taste;
}

export class FeedService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly hydrator: PostHydrator,
    private readonly agePolicy: AgePolicy,
    private readonly logger: FastifyBaseLogger,
  ) {}

  // ------------------------------------------------------------------ FOLLOWING (chronological)

  /**
   * Everything from people you follow (and yourself), newest first. No ranking: this is the
   * predictable feed. Keyset-paginated, so new posts never shift or repeat earlier pages.
   */
  async following(
    viewerId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<FeedPage> {
    const cursor = args.cursor ? decodeCursor(args.cursor, FollowingCursor) : undefined;
    let q = this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select([...POST_COLUMNS, timestampText('p.published_at').as('ts')])
      .where(postListableBy(viewerId))
      .where((eb) =>
        eb.or([eb('p.authorId', '=', viewerId), viewerFollows(viewerId, 'p.author_id')]),
      )
      .where(notInterested(viewerId))
      .orderBy('p.publishedAt', 'desc')
      .orderBy('p.id', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('p.published_at', 'p.id', cursor));

    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const posts = await this.hydrator.hydrate(viewerId, page);
    const reasonOf = new Map(
      page.map((r) => [r.id, r.authorId === viewerId ? 'OWN_POST' : 'FOLLOWED_AUTHOR'] as const),
    );
    const entries = posts.map((post) => ({
      post,
      reason: reasonOf.get(post.id) ?? 'FOLLOWED_AUTHOR',
      score: null,
      signals: {},
    }));

    const requestId = await this.logServed(viewerId, {
      surface: 'FOLLOWING',
      algorithmVersion: ALGORITHM_VERSIONS.FOLLOWING,
      snapshotId: null,
      offset: 0,
      entries,
    });
    const last = page[page.length - 1];
    return {
      requestId,
      algorithmVersion: ALGORITHM_VERSIONS.FOLLOWING,
      items: toItems(entries),
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  // ------------------------------------------------------------------ HOME / EXPLORE (ranked)

  home(viewerId: string, args: { limit: number; cursor?: string | undefined }): Promise<FeedPage> {
    return this.ranked(viewerId, 'HOME', args);
  }

  explore(
    viewerId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<FeedPage> {
    return this.ranked(viewerId, 'EXPLORE', args);
  }

  /**
   * Ranked feeds are finite lists frozen at refresh time ("snapshots"). The first request ranks
   * and stores a list; later pages walk that stored list, so pagination is exactly-once and stable
   * even though scores keep moving. Visibility is re-checked every time a page is served, so a
   * post that was deleted, hidden, or whose author blocked you since the refresh is silently skipped.
   */
  private async ranked(
    viewerId: string,
    surface: RankedSurface,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<FeedPage> {
    const cursor = args.cursor ? decodeCursor(args.cursor, SnapshotCursor) : undefined;
    const algorithmVersion =
      surface === 'HOME' ? ALGORITHM_VERSIONS.HOME : ALGORITHM_VERSIONS.EXPLORE;

    let snapshotId: string;
    let items: SnapshotItem[];
    let offset: number;
    if (cursor) {
      const snapshot = await this.loadSnapshot(viewerId, surface, cursor.s);
      snapshotId = cursor.s;
      items = snapshot;
      offset = cursor.o;
    } else {
      const built = await this.buildSnapshot(viewerId, surface);
      snapshotId = built.id;
      items = built.items;
      offset = 0;
    }

    const { entries, next } = await this.serve(viewerId, items, offset, args.limit);
    const requestId = await this.logServed(viewerId, {
      surface,
      algorithmVersion,
      snapshotId,
      offset,
      entries,
    });
    return {
      requestId,
      algorithmVersion,
      items: toItems(entries),
      nextCursor: next < items.length ? encodeCursor({ s: snapshotId, o: next }) : null,
    };
  }

  private async loadSnapshot(
    viewerId: string,
    surface: RankedSurface,
    snapshotId: string,
  ): Promise<SnapshotItem[]> {
    const row = await this.db
      .selectFrom('feedSnapshots')
      .select(['items', 'surface'])
      .where('id', '=', snapshotId)
      .where('userId', '=', viewerId) // someone else's snapshot is indistinguishable from a missing one
      .where('expiresAt', '>', this.clock.now())
      .executeTakeFirst();
    if (!row) throw new AppError('FEED_EXPIRED');
    if (row.surface !== surface) throw new AppError('INVALID_CURSOR');
    const parsed = SnapshotItems.safeParse(row.items);
    if (!parsed.success) throw new AppError('FEED_EXPIRED');
    return parsed.data;
  }

  /**
   * Walks the stored list from `offset`, dropping entries that are no longer listable for the
   * viewer, until `limit` items are collected or the list ends. Returns the new offset.
   */
  private async serve(
    viewerId: string,
    list: readonly SnapshotItem[],
    offset: number,
    limit: number,
  ): Promise<{ entries: Entry[]; next: number }> {
    const entries: Entry[] = [];
    let pos = offset;
    while (entries.length < limit && pos < list.length) {
      const chunk = list.slice(pos, pos + limit * 2);
      const ids = chunk.map((i) => i.p);
      const rows = await this.db
        .selectFrom('posts as p')
        .innerJoin('users as au', 'au.id', 'p.authorId')
        .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
        .select(POST_COLUMNS)
        .where('p.id', 'in', ids)
        .where(postListableBy(viewerId))
        .where(notInterested(viewerId))
        .execute();
      const posts = new Map(
        (await this.hydrator.hydrate(viewerId, rows)).map((post) => [post.id, post]),
      );
      for (const item of chunk) {
        pos += 1;
        const post = posts.get(item.p);
        if (post) entries.push({ post, reason: item.r, score: item.s, signals: item.f });
        if (entries.length === limit) break;
      }
    }
    return { entries, next: pos };
  }

  // ------------------------------------------------------------------ building a ranked list

  private async buildSnapshot(
    viewerId: string,
    surface: RankedSurface,
  ): Promise<{ id: string; items: SnapshotItem[] }> {
    const now = this.clock.now();
    const viewer = await this.viewerContext(viewerId);

    const [followed, trending, fresh, sport] = await Promise.all([
      surface === 'HOME'
        ? this.candidates(viewerId, 'FOLLOWED', {
            since: daysAgo(now, FOLLOWED_WINDOW_DAYS),
            limit: FOLLOWED_POOL,
          })
        : [],
      this.candidates(viewerId, 'TRENDING', {
        since: daysAgo(now, DISCOVERY_WINDOW_DAYS),
        limit: TRENDING_POOL,
        noSponsored: viewer.isMinor,
      }),
      this.candidates(viewerId, 'FRESH', {
        since: daysAgo(now, DISCOVERY_WINDOW_DAYS),
        limit: FRESH_POOL,
        noSponsored: viewer.isMinor,
      }),
      viewer.sportKeys.length > 0
        ? this.candidates(viewerId, 'SPORT', {
            since: daysAgo(now, SPORT_WINDOW_DAYS),
            limit: SPORT_POOL,
            sportKeys: viewer.sportKeys,
            noSponsored: viewer.isMinor,
          })
        : [],
    ]);

    const discoveryById = new Map<string, Candidate>();
    for (const c of [...trending, ...fresh, ...sport]) discoveryById.set(c.postId, c);
    const followedIds = new Set(followed.map((c) => c.postId));
    const discovery = [...discoveryById.values()].filter((c) => !followedIds.has(c.postId));

    const all = [...followed, ...discovery];
    await this.attachTopicsAndSeen(viewerId, all, viewer.personalized);

    const size = this.config.FEED_SNAPSHOT_SIZE;
    let ordered: ScoredCandidate[];
    let ranked: ScoredCandidate[];
    if (surface === 'HOME') {
      const primary = rank(followed, viewer.taste, now);
      const extra = rank(discovery, viewer.taste, now);
      ordered = interleave(primary, extra, HOME_DISCOVERY_EVERY);
      ranked = diversify(ordered, HOME_DIVERSITY, size);
    } else {
      ordered = rank(discovery, viewer.taste, now);
      ranked = diversify(ordered, EXPLORE_DIVERSITY, size);
    }

    const items: SnapshotItem[] = ranked.map((r) => ({
      p: r.candidate.postId,
      s: r.score,
      r: r.reason,
      f: r.signals,
    }));
    const id = uuidv7();
    await this.db
      .insertInto('feedSnapshots')
      .values({
        id,
        userId: viewerId,
        surface,
        algorithmVersion: surface === 'HOME' ? ALGORITHM_VERSIONS.HOME : ALGORITHM_VERSIONS.EXPLORE,
        items: JSON.stringify(items),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.config.FEED_SNAPSHOT_TTL_MINUTES * 60_000),
      })
      .execute();
    return { id, items };
  }

  private async viewerContext(viewerId: string): Promise<ViewerContext> {
    const [settings, age, prefs, profile] = await Promise.all([
      this.db
        .selectFrom('userSettings')
        .select('personalizationEnabled')
        .where('userId', '=', viewerId)
        .executeTakeFirst(),
      this.agePolicy.ageOf(viewerId),
      this.db
        .selectFrom('sportPreferences')
        .select(['sportKey', 'relation'])
        .where('userId', '=', viewerId)
        .execute(),
      this.db
        .selectFrom('profiles')
        .select('primarySportKey')
        .where('userId', '=', viewerId)
        .executeTakeFirst(),
    ]);
    const personalized = settings?.personalizationEnabled ?? true;
    const learned = personalized
      ? await this.db
          .selectFrom('userAffinities')
          .select(['subjectType', 'subjectKey', 'score'])
          .where('userId', '=', viewerId)
          .execute()
      : [];

    const maps = {
      SPORT: new Map<string, number>(),
      CREATOR: new Map<string, number>(),
      FORMAT: new Map<string, number>(),
      TOPIC: new Map<string, number>(),
    };
    for (const a of learned) maps[a.subjectType].set(a.subjectKey, a.score);

    // Declared sports are an explicit profile choice (not behavioural tracking), so they apply
    // even with personalization off.
    const explicit = new Map<string, number>();
    for (const p of prefs) {
      const value = EXPLICIT_SPORT_AFFINITY[p.relation];
      explicit.set(p.sportKey, Math.max(explicit.get(p.sportKey) ?? 0, value));
    }
    if (profile?.primarySportKey) {
      explicit.set(
        profile.primarySportKey,
        Math.max(explicit.get(profile.primarySportKey) ?? 0, EXPLICIT_SPORT_AFFINITY.PRIMARY),
      );
    }
    for (const [sport, base] of explicit) {
      maps.SPORT.set(sport, Math.max(-1, Math.min(1, base + (maps.SPORT.get(sport) ?? 0))));
    }

    return {
      personalized,
      isMinor: age < this.config.ADULT_AGE,
      sportKeys: [...new Set([...explicit.keys(), ...positive(maps.SPORT)])],
      taste: {
        personalized,
        sport: maps.SPORT,
        creator: maps.CREATOR,
        format: maps.FORMAT,
        topic: maps.TOPIC,
      },
    };
  }

  /** One candidate pool. Every pool applies the viewer-facing visibility predicate in SQL. */
  private async candidates(
    viewerId: string,
    pool: 'FOLLOWED' | 'TRENDING' | 'FRESH' | 'SPORT',
    opts: { since: Date; limit: number; noSponsored?: boolean; sportKeys?: string[] },
  ): Promise<Candidate[]> {
    let q = this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .leftJoin('activities as act', 'act.id', 'p.activityId')
      .leftJoin('postStats as ps', 'ps.postId', 'p.id')
      .leftJoin('sponsorshipDisclosures as sd', 'sd.postId', 'p.id')
      .leftJoin('creatorProfiles as cp', 'cp.userId', 'p.authorId')
      .select([
        'p.id',
        'p.authorId',
        'p.publishedAt',
        'p.format',
        'p.reactionCount',
        'p.commentCount',
        'p.shareCount',
        'p.bookmarkCount',
        'act.sportKey',
        sql<boolean>`sd.post_id is not null`.as('sponsored'),
        sql<boolean>`cp.user_id is not null`.as('authorIsCreator'),
        sql<number>`coalesce(ps.impressions, 0)`.as('impressions'),
        sql<number>`coalesce(ps.video_starts, 0)`.as('videoStarts'),
        sql<number>`coalesce(ps.video_completes, 0)`.as('videoCompletes'),
        sql<number>`coalesce(ps.skips, 0)`.as('skips'),
        sql<number>`coalesce(ps.not_interested, 0)`.as('notInterested'),
      ])
      .where(postListableBy(viewerId))
      .where(notInterested(viewerId))
      .where('p.publishedAt', '>', opts.since)
      .limit(opts.limit);

    if (pool === 'FOLLOWED') {
      q = q
        .where((eb) =>
          eb.or([eb('p.authorId', '=', viewerId), viewerFollows(viewerId, 'p.author_id')]),
        )
        .orderBy('p.publishedAt', 'desc')
        .orderBy('p.id', 'desc');
    } else {
      // Discovery: other people's posts, from authors who opted in to being discoverable.
      q = q
        .where('p.authorId', '!=', viewerId)
        .where(sql<boolean>`not ${viewerFollows(viewerId, 'p.author_id')}`)
        .where('ap.discoverable', '=', true);
      if (opts.noSponsored) q = q.where(sql<boolean>`sd.post_id is null`);
      if (pool === 'TRENDING') {
        q = q
          .orderBy(sql`(p.reaction_count + 2 * p.comment_count + 3 * p.share_count)`, 'desc')
          .orderBy('p.publishedAt', 'desc')
          .orderBy('p.id', 'desc');
      } else if (pool === 'SPORT') {
        q = q
          .where('act.sportKey', 'in', opts.sportKeys ?? [])
          .orderBy('p.publishedAt', 'desc')
          .orderBy('p.id', 'desc');
      } else {
        q = q.orderBy('p.publishedAt', 'desc').orderBy('p.id', 'desc');
      }
    }

    const rows = await q.execute();
    const followedPool = pool === 'FOLLOWED';
    return rows.map((r): Candidate => ({
      postId: r.id,
      authorId: r.authorId,
      // published posts always have the timestamp; fall back defensively so ranking never throws
      publishedAt: r.publishedAt ?? new Date(0),
      format: r.format,
      sportKey: r.sportKey,
      topics: [],
      sponsored: r.sponsored,
      authorIsCreator: r.authorIsCreator,
      isOwn: r.authorId === viewerId,
      isFollowed: followedPool && r.authorId !== viewerId,
      reactions: r.reactionCount,
      comments: r.commentCount,
      shares: r.shareCount,
      bookmarks: r.bookmarkCount,
      impressions: r.impressions,
      videoStarts: r.videoStarts,
      videoCompletes: r.videoCompletes,
      skips: r.skips,
      notInterested: r.notInterested,
      timesSeen: 0,
    }));
  }

  /** Topics (for affinity) and how often the viewer was already shown each post. Two queries total. */
  private async attachTopicsAndSeen(
    viewerId: string,
    candidates: Candidate[],
    personalized: boolean,
  ): Promise<void> {
    if (candidates.length === 0) return;
    const ids = candidates.map((c) => c.postId);
    const seenSince = daysAgo(this.clock.now(), SEEN_LOOKBACK_DAYS);
    const [topicRows, seenRows] = await Promise.all([
      this.db
        .selectFrom('postTopics as pt')
        .innerJoin('topics as t', 't.id', 'pt.topicId')
        .select(['pt.postId', 't.slug'])
        .where('pt.postId', 'in', ids)
        .execute(),
      personalized
        ? this.db
            .selectFrom('feedEvents')
            .select(['postId', (eb) => eb.fn.countAll<number>().as('n')])
            .where('userId', '=', viewerId)
            .where('eventType', '=', 'IMPRESSION')
            .where('createdAt', '>', seenSince)
            .where('postId', 'in', ids)
            .groupBy('postId')
            .execute()
        : [],
    ]);
    const topics = new Map<string, string[]>();
    for (const r of topicRows) topics.set(r.postId, [...(topics.get(r.postId) ?? []), r.slug]);
    const seen = new Map(seenRows.map((r) => [r.postId, Number(r.n)]));
    for (const c of candidates) {
      c.topics = topics.get(c.postId) ?? [];
      c.timesSeen = seen.get(c.postId) ?? 0;
    }
  }

  // ------------------------------------------------------------------ serving log

  /**
   * Records what was shown (one `feed_requests` row, plus a per-item decision log sampled by
   * RANKING_LOG_SAMPLE_RATE). The id is returned to the client as `requestId` so its events can be
   * attributed. Logging must never break the feed: on failure the page is still served.
   */
  private async logServed(
    viewerId: string,
    page: {
      surface: FeedSurface;
      algorithmVersion: string;
      snapshotId: string | null;
      offset: number;
      entries: Entry[];
    },
  ): Promise<string> {
    const requestId = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('feedRequests')
          .values({
            id: requestId,
            userId: viewerId,
            surface: page.surface,
            algorithmVersion: page.algorithmVersion,
            snapshotId: page.snapshotId,
            pageOffset: page.offset,
            itemCount: page.entries.length,
            createdAt: this.clock.now(),
          })
          .execute();
        if (page.entries.length > 0 && Math.random() < this.config.RANKING_LOG_SAMPLE_RATE) {
          await trx
            .insertInto('recommendationEvents')
            .values(
              page.entries.map((e, position) => ({
                feedRequestId: requestId,
                position,
                postId: e.post.id,
                score: e.score,
                reason: e.reason,
                signals: JSON.stringify(e.signals),
              })),
            )
            .execute();
        }
      });
    } catch (err) {
      this.logger.warn({ err, surface: page.surface }, 'failed to write the feed serving log');
    }
    return requestId;
  }
}

interface Entry {
  post: Post;
  reason: FeedItem['reason'];
  score: number | null;
  signals: Record<string, number>;
}

function toItems(entries: Entry[]): FeedItem[] {
  return entries.map((e, position) => ({ post: e.post, reason: e.reason, position }));
}

/** Excludes posts the viewer marked "not interested" (served from the partial index). */
function notInterested(viewerId: string): RawBuilder<boolean> {
  return sql<boolean>`not exists (
    select 1 from feed_events _ni
     where _ni.user_id = ${viewerId} and _ni.post_id = p.id and _ni.event_type = 'NOT_INTERESTED'
  )`;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

function positive(scores: ReadonlyMap<string, number>): string[] {
  return [...scores].filter(([, v]) => v > 0.2).map(([k]) => k);
}
