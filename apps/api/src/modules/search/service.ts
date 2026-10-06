import { z } from 'zod';
import type { Post, TopicResult, UserSummary } from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { decodeCursor, encodeCursor } from '../../platform/http/cursor';
import { POST_COLUMNS, type PostHydrator } from '../posts/hydrator';
import type { UserDirectory } from '../users/directory';
import { minorCutoffDate, normalizeSearchText, searchablePost, searchableUser } from './predicates';
import type { SearchContext, SearchProvider } from './provider';

const OffsetCursor = z.object({ o: z.number().int().min(0) });
/** Search results are capped: nobody pages through thousands of hits, and deep offsets are costly. */
const MAX_RESULTS = 500;
const OVERVIEW_SIZE = 5;

export interface SearchPage<T> {
  items: T[];
  nextCursor: string | null;
}

export class SearchService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly provider: SearchProvider,
    private readonly directory: UserDirectory,
    private readonly hydrator: PostHydrator,
  ) {}

  private context(viewerId: string): SearchContext {
    return {
      viewerId,
      minorCutoffDate: minorCutoffDate(this.clock.now(), this.config.MINOR_PUBLIC_MIN_AGE),
    };
  }

  private paging(args: { limit: number; cursor?: string | undefined }) {
    const offset = args.cursor ? decodeCursor(args.cursor, OffsetCursor).o : 0;
    const limit = Math.max(0, Math.min(args.limit, MAX_RESULTS - offset));
    return { offset, limit };
  }

  private nextCursor(offset: number, limit: number, hasMore: boolean): string | null {
    const next = offset + limit;
    return hasMore && limit > 0 && next < MAX_RESULTS ? encodeCursor({ o: next }) : null;
  }

  async users(
    viewerId: string,
    q: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<SearchPage<UserSummary>> {
    const text = normalizeSearchText(q);
    const { offset, limit } = this.paging(args);
    const ctx = this.context(viewerId);
    const { hits, hasMore } = await this.provider.searchUsers(ctx, text, { offset, limit });
    const allowed = await this.allowedUsers(ctx, hits);
    const summaries = await this.directory.summaries(allowed);
    return {
      items: allowed.flatMap((id) => {
        const s = summaries.get(id);
        return s ? [s] : [];
      }),
      nextCursor: this.nextCursor(offset, limit, hasMore),
    };
  }

  async posts(
    viewerId: string,
    q: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<SearchPage<Post>> {
    const text = normalizeSearchText(q);
    const { offset, limit } = this.paging(args);
    const { hits, hasMore } = await this.provider.searchPosts(this.context(viewerId), text, {
      offset,
      limit,
    });
    return {
      items: await this.hydratePosts(viewerId, hits),
      nextCursor: this.nextCursor(offset, limit, hasMore),
    };
  }

  async topics(
    viewerId: string,
    q: string,
    args: { limit: number; cursor?: string | undefined },
  ): Promise<SearchPage<TopicResult>> {
    const text = normalizeSearchText(q);
    const { offset, limit } = this.paging(args);
    const { hits, hasMore } = await this.provider.searchTopics(this.context(viewerId), text, {
      offset,
      limit,
    });
    return { items: hits, nextCursor: this.nextCursor(offset, limit, hasMore) };
  }

  /** The first screen of results: a few of each kind. */
  async overview(viewerId: string, q: string) {
    const first = { limit: OVERVIEW_SIZE };
    const [users, topics, posts] = await Promise.all([
      this.users(viewerId, q, first),
      this.topics(viewerId, q, first),
      this.posts(viewerId, q, first),
    ]);
    return { users: users.items, topics: topics.items, posts: posts.items };
  }

  // ------------------------------------------------------------------ authoritative re-checks

  /** Keeps only ids the viewer may be shown, in the provider's order. */
  private async allowedUsers(ctx: SearchContext, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select('p.userId')
      .where('p.userId', 'in', [...ids])
      .where(searchableUser(ctx.viewerId, ctx.minorCutoffDate))
      .execute();
    const ok = new Set(rows.map((r) => r.userId));
    return ids.filter((id) => ok.has(id));
  }

  /** Loads, authorises and hydrates posts, preserving `ids` order. Shared with discovery. */
  async hydratePosts(viewerId: string, ids: readonly string[]): Promise<Post[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select(POST_COLUMNS)
      .where('p.id', 'in', [...ids])
      .where(searchablePost(viewerId))
      .execute();
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return this.hydrator.hydrate(viewerId, rows);
  }
}
