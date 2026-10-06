import { sql } from 'kysely';
import type { Db } from '../../platform/db/client';
import {
  likeEscape,
  publicTopicPostCount,
  searchablePost,
  searchableUser,
  toPrefixTsQuery,
} from './predicates';
import type { SearchContext, SearchHits, SearchPaging, SearchProvider, TopicHit } from './provider';

const CANDIDATE_LIMIT = 100;

/** Search on PostgreSQL: pg_trgm for names/topics, full-text search for post text. */
export class PostgresSearchProvider implements SearchProvider {
  readonly name = 'postgres';

  constructor(private readonly db: Db) {}

  async searchUsers(
    ctx: SearchContext,
    text: string,
    { offset, limit }: SearchPaging,
  ): Promise<SearchHits<string>> {
    const like = likeEscape(text);
    const rows = await this.db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select([
        'p.userId',
        sql<number>`(
          case when lower(p.username::text) = ${text} then 4 else 0 end
          + case when p.username::text ilike ${`${like}%`} then 3 else 0 end
          + case when lower(p.display_name) like ${`${like}%`} then 2 else 0 end
          + greatest(similarity(p.username::text, ${text}), similarity(lower(p.display_name), ${text}))
        )`.as('score'),
      ])
      .where(searchableUser(ctx.viewerId, ctx.minorCutoffDate))
      .where(
        sql<boolean>`(
          p.username::text ilike ${`%${like}%`}
          or lower(p.display_name) like ${`%${like}%`}
          or p.username::text % ${text}
        )`,
      )
      .orderBy('score', 'desc')
      .orderBy('p.followerCount', 'desc')
      .orderBy('p.userId')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    return slice(
      rows.map((r) => r.userId),
      limit,
    );
  }

  async searchPosts(
    ctx: SearchContext,
    text: string,
    { offset, limit }: SearchPaging,
  ): Promise<SearchHits<string>> {
    const tsQuery = toPrefixTsQuery(text);
    if (!tsQuery) return { hits: [], hasMore: false };
    // A single word also matches posts TAGGED with it, even when the caption does not contain it.
    const single = /^[\p{L}\p{N}_]+$/u.test(text) ? text : null;
    const tagged =
      single === null
        ? sql<boolean>`false`
        : sql<boolean>`exists (
            select 1 from post_topics pt join topics t on t.id = pt.topic_id
             where pt.post_id = p.id and t.slug = ${single}
          )`;

    const rows = await this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select([
        'p.id',
        sql<number>`ts_rank_cd(p.search_tsv, to_tsquery('simple', ${tsQuery}))`.as('rank'),
      ])
      .where(searchablePost(ctx.viewerId))
      .where(sql<boolean>`(p.search_tsv @@ to_tsquery('simple', ${tsQuery}) or ${tagged})`)
      .orderBy('rank', 'desc')
      .orderBy('p.publishedAt', 'desc')
      .orderBy('p.id', 'desc')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    return slice(
      rows.map((r) => r.id),
      limit,
    );
  }

  async searchTopics(
    _ctx: SearchContext,
    text: string,
    { offset, limit }: SearchPaging,
  ): Promise<SearchHits<TopicHit>> {
    const like = likeEscape(text);
    // Step 1: cheap candidate selection by name only.
    const candidates = await this.db
      .selectFrom('topics as t')
      .select([
        't.id',
        't.slug',
        sql<number>`case when t.slug::text like ${`${like}%`} then 1 else 0 end`.as('prefix'),
      ])
      .where(sql<boolean>`(t.slug::text like ${`%${like}%`} or t.slug::text % ${text})`)
      .orderBy('prefix', 'desc')
      .orderBy('t.slug')
      .limit(CANDIDATE_LIMIT)
      .execute();
    if (candidates.length === 0) return { hits: [], hasMore: false };

    // Step 2: count public usage for just those, and drop topics nobody public uses.
    const counts = await this.db
      .selectFrom('topics as t')
      .select(['t.id', publicTopicPostCount('t.id').as('postCount')])
      .where(
        't.id',
        'in',
        candidates.map((c) => c.id),
      )
      .execute();
    const countById = new Map(counts.map((c) => [c.id, c.postCount]));
    const live = candidates
      .map((c) => ({ slug: c.slug, prefix: c.prefix, postCount: countById.get(c.id) ?? 0 }))
      .filter((c) => c.postCount > 0)
      .sort(
        (a, b) => b.prefix - a.prefix || b.postCount - a.postCount || a.slug.localeCompare(b.slug),
      )
      .slice(offset, offset + limit + 1);
    return slice(
      live.map((r) => ({ slug: r.slug, postCount: r.postCount })),
      limit,
    );
  }
}

function slice<T>(rows: T[], limit: number): SearchHits<T> {
  return { hits: rows.slice(0, limit), hasMore: rows.length > limit };
}
