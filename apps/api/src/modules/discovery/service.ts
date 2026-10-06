import { sql } from 'kysely';
import { z } from 'zod';
import type {
  Post,
  SuggestedAthlete,
  SuggestionReason,
  TopicResult,
  TrendingTopic,
} from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import { POST_COLUMNS, type PostHydrator } from '../posts/hydrator';
import {
  minorCutoffDate,
  normalizeSearchText,
  publicTopicPostCount,
  searchablePost,
  searchableUser,
} from '../search/predicates';
import { postListableBy } from '../posts/visibility';
import type { UserDirectory } from '../users/directory';

const TimeCursor = z.object({ t: z.string(), id: z.uuid() });
const OffsetCursor = z.object({ o: z.number().int().min(0) });
const MAX_SUGGESTIONS = 200;
const TRENDING_WINDOW_DAYS = 7;
/** A topic only trends when several people use it, so one account cannot pump a hashtag. */
const TRENDING_MIN_AUTHORS = 2;
const FOLLOWEE_SAMPLE = 200;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class DiscoveryService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly directory: UserDirectory,
    private readonly hydrator: PostHydrator,
  ) {}

  // ------------------------------------------------------------------ who to follow

  /**
   * People you might want to follow: friends-of-friends first, then people who share your
   * sports, then popular and creator accounts. Never yourself, anyone you already follow or
   * requested, blocked users, opted-out accounts, minors, or accounts with nothing posted.
   */
  async suggestedAthletes(
    viewerId: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<Page<SuggestedAthlete>> {
    const offset = args.cursor ? decodeCursor(args.cursor, OffsetCursor).o : 0;
    const limit = Math.max(0, Math.min(args.limit, MAX_SUGGESTIONS - offset));
    if (limit === 0) return { items: [], nextCursor: null };

    const [prefs, profile] = await Promise.all([
      this.db
        .selectFrom('sportPreferences')
        .select('sportKey')
        .where('userId', '=', viewerId)
        .execute(),
      this.db
        .selectFrom('profiles')
        .select('primarySportKey')
        .where('userId', '=', viewerId)
        .executeTakeFirst(),
    ]);
    const sports = [
      ...new Set([
        ...prefs.map((p) => p.sportKey),
        ...(profile?.primarySportKey ? [profile.primarySportKey] : []),
      ]),
    ];
    const cutoff = minorCutoffDate(this.clock.now(), this.config.MINOR_PUBLIC_MIN_AGE);

    const { rows } = await sql<{
      userId: string;
      mutual: number;
      primarySportKey: string | null;
      sameSport: boolean;
      isCreator: boolean;
    }>`
      with mine as (
        select followee_id from follows where follower_id = ${viewerId}
         order by created_at desc limit ${FOLLOWEE_SAMPLE}
      ),
      mutual as (
        select f.followee_id as user_id, count(*)::int as n
          from follows f join mine m on m.followee_id = f.follower_id
         group by f.followee_id
      )
      select p.user_id, coalesce(mu.n, 0) as mutual, p.primary_sport_key,
             coalesce(p.primary_sport_key = any(${sports}::text[]), false) as same_sport,
             (cp.user_id is not null) as is_creator
        from profiles p
        join users u on u.id = p.user_id
        left join mutual mu on mu.user_id = p.user_id
        left join creator_profiles cp on cp.user_id = p.user_id
       where p.user_id <> ${viewerId}
         and p.post_count > 0
         and ${searchableUser(viewerId, cutoff)}
         and not exists (select 1 from follows f2 where f2.follower_id = ${viewerId} and f2.followee_id = p.user_id)
         and not exists (select 1 from follow_requests fr where fr.requester_id = ${viewerId} and fr.target_id = p.user_id)
       order by (
                  coalesce(mu.n, 0) * 3
                  + case when coalesce(p.primary_sport_key = any(${sports}::text[]), false) then 2 else 0 end
                  + ln(1 + p.follower_count) * 0.5
                  + case when cp.verification_status = 'VERIFIED' then 0.5 else 0 end
                ) desc,
                p.follower_count desc, p.user_id
       offset ${offset} limit ${limit + 1}`.execute(this.db);

    const { page, hasMore } = sliceProbe(rows, limit);
    const users = await this.directory.summaries(page.map((r) => r.userId));
    const items = page.flatMap((r): SuggestedAthlete[] => {
      const user = users.get(r.userId);
      if (!user) return [];
      const reason: SuggestionReason =
        r.mutual > 0
          ? 'FOLLOWED_BY_FOLLOWING'
          : r.sameSport
            ? 'SAME_SPORT'
            : r.isCreator
              ? 'CREATOR'
              : 'POPULAR';
      return [
        {
          user,
          reason,
          mutualFollowers: r.mutual,
          primarySport: r.primarySportKey as SuggestedAthlete['primarySport'],
        },
      ];
    });
    const next = offset + limit;
    return {
      items,
      nextCursor: hasMore && next < MAX_SUGGESTIONS ? encodeCursor({ o: next }) : null,
    };
  }

  // ------------------------------------------------------------------ topics

  async trendingTopics(limit: number): Promise<TrendingTopic[]> {
    const since = new Date(this.clock.now().getTime() - TRENDING_WINDOW_DAYS * 86_400_000);
    const { rows } = await sql<{ slug: string; postCount: number; authorCount: number }>`
      select t.slug::text as slug, count(*)::int as post_count, count(distinct p.author_id)::int as author_count
        from post_topics pt
        join topics t on t.id = pt.topic_id
        join posts p on p.id = pt.post_id
        join users au on au.id = p.author_id
        join profiles ap on ap.user_id = p.author_id
       where p.published_at > ${since}
         and ${postListableBy(null)}
         and ap.discoverable
       group by t.slug
      having count(distinct p.author_id) >= ${TRENDING_MIN_AUTHORS}
       order by author_count desc, post_count desc, t.slug
       limit ${limit}`.execute(this.db);
    return rows;
  }

  async topic(rawSlug: string): Promise<TopicResult> {
    const slug = normalizeSearchText(rawSlug);
    const row = await this.db
      .selectFrom('topics as t')
      .select(['t.slug', publicTopicPostCount('t.id').as('postCount')])
      .where('t.slug', '=', slug)
      .executeTakeFirst();
    if (!row) throw new AppError('TOPIC_NOT_FOUND');
    return { slug: row.slug, postCount: row.postCount };
  }

  /** Newest-first posts using a topic, limited to what the viewer (or an anonymous visitor) may see. */
  async topicPosts(
    viewerId: string | null,
    rawSlug: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<Page<Post>> {
    const { slug } = await this.topic(rawSlug);
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('postTopics as pt')
      .innerJoin('topics as t', 't.id', 'pt.topicId')
      .innerJoin('posts as p', 'p.id', 'pt.postId')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select([...POST_COLUMNS, timestampText('p.published_at').as('ts')])
      .where('t.slug', '=', slug)
      .where(searchablePost(viewerId))
      .orderBy('p.publishedAt', 'desc')
      .orderBy('p.id', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('p.published_at', 'p.id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrator.hydrate(viewerId, page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }
}
