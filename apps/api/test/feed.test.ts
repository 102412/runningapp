import type { LogEvent } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, errorCode, relogin, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

interface FeedItem {
  post: { id: string; author: { id: string }; sponsorship: unknown };
  reason: string;
  position: number;
}
interface FeedPage {
  requestId: string;
  algorithmVersion: string;
  items: FeedItem[];
  nextCursor: string | null;
}

describe('feeds', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption = 'a public post', extra: Record<string, unknown> = {}) =>
    createPost(t, user, { caption, visibility: 'PUBLIC', ...extra }) as Promise<{ id: string }>;

  async function fetchFeed(
    user: TestUser,
    surface: 'following' | 'home' | 'explore',
    query = '',
  ): Promise<FeedPage> {
    const res = await api(t, user).get(`/feed/${surface}${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FeedPage>();
  }

  async function allPages(
    user: TestUser,
    surface: 'following' | 'home' | 'explore',
    limit: number,
  ): Promise<FeedPage[]> {
    const pages: FeedPage[] = [];
    let cursor: string | null = null;
    do {
      const page: FeedPage = await fetchFeed(
        user,
        surface,
        `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 50);
    return pages;
  }

  const ids = (page: FeedPage) => page.items.map((i) => i.post.id);

  it('requires authentication on every feed', async () => {
    for (const surface of ['following', 'home', 'explore']) {
      expect((await api(t).get(`/feed/${surface}`)).statusCode).toBe(401);
    }
    expect((await api(t).post('/events', { events: [] })).statusCode).toBe(401);
  });

  describe('following (chronological)', () => {
    it('shows followed authors and you, newest first, with stable keyset pages', async () => {
      const me = await signupUser(t);
      const b = await signupUser(t);
      const c = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(t, me, b);
      await follow(t, me, c);

      const posts: string[] = [];
      for (const author of [b, c, me, stranger, b]) {
        t.clock.advanceSeconds(1);
        posts.push((await pub(author)).id);
      }
      const [p1, p2, p3, p4, p5] = posts as [string, string, string, string, string];

      const first = await fetchFeed(me, 'following', '?limit=2');
      expect(ids(first)).toEqual([p5, p3]);
      expect(first.items.map((i) => i.reason)).toEqual(['FOLLOWED_AUTHOR', 'OWN_POST']);
      expect(first.items.map((i) => i.position)).toEqual([0, 1]);
      expect(first.algorithmVersion).toBe('chrono-v1');

      // A post published after page 1 must not shift or repeat page 2.
      t.clock.advanceSeconds(1);
      const p6 = (await pub(b)).id;
      const second = await fetchFeed(me, 'following', `?limit=2&cursor=${first.nextCursor}`);
      expect(ids(second)).toEqual([p2, p1]);
      expect(second.nextCursor).toBeNull();
      expect(new Set(ids(second)).has(p6)).toBe(false);
      expect(p4).toBeDefined();

      // ...but it leads the next refresh.
      expect(ids(await fetchFeed(me, 'following', '?limit=1'))).toEqual([p6]);
    });

    it('applies visibility: unfollow, blocks (either direction), non-public posts, drafts, hidden and deleted', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      await follow(t, me, friend);

      const live = await pub(friend, 'live');
      const followersOnly = await createPost(t, friend, {
        caption: 'followers',
        visibility: 'FOLLOWERS',
      });
      const privatePost = await createPost(t, friend, { caption: 'mine', visibility: 'PRIVATE' });
      const draft = await createPost(t, friend, { caption: 'draft', publish: false });
      const hidden = await pub(friend, 'hidden');
      const deleted = await pub(friend, 'deleted');
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'HIDDEN' })
        .where('id', '=', hidden.id)
        .execute();
      expect((await api(t, friend).del(`/posts/${deleted.id}`)).statusCode).toBe(204);

      const shown = ids(await fetchFeed(me, 'following')).sort();
      expect(shown).toEqual([live.id, followersOnly.id].sort());
      expect(shown).not.toContain(privatePost.id);
      expect(shown).not.toContain(draft.id);

      // Unfollowing removes everything.
      await api(t, me).del(`/users/${friend.id}/follow`);
      expect(ids(await fetchFeed(me, 'following'))).toEqual([]);
    });

    it('drops an author as soon as a block exists in either direction', async () => {
      const me = await signupUser(t);
      const a = await signupUser(t);
      const b = await signupUser(t);
      await follow(t, me, a);
      await follow(t, me, b);
      await pub(a);
      await pub(b);
      expect(await fetchFeed(me, 'following')).toMatchObject({ items: expect.any(Array) });
      expect((await fetchFeed(me, 'following')).items).toHaveLength(2);

      await api(t, me).put(`/users/${a.id}/block`); // I block a
      await api(t, b).put(`/users/${me.id}/block`); // b blocks me
      expect((await fetchFeed(me, 'following')).items).toHaveLength(0);
    });
  });

  describe('home and explore (ranked)', () => {
    it('serves discovery content to a brand-new user and never their own or invisible posts', async () => {
      const me = await signupUser(t);
      const open = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const hiddenFromSearch = await signupUser(t);
      const blocker = await signupUser(t);
      const blocked = await signupUser(t);
      await t.platform.db
        .updateTable('profiles')
        .set({ discoverable: false })
        .where('userId', '=', hiddenFromSearch.id)
        .execute();

      const visible = await pub(open, 'open');
      const own = await pub(me, 'my own');
      await pub(priv, 'private account');
      await pub(hiddenFromSearch, 'not discoverable');
      await createPost(t, open, { caption: 'followers only', visibility: 'FOLLOWERS' });
      await pub(blocker, 'blocker');
      await pub(blocked, 'blocked');
      await api(t, me).put(`/users/${blocked.id}/block`);
      await api(t, blocker).put(`/users/${me.id}/block`);

      // Explore is for discovering OTHER people: never your own posts.
      const explore = await fetchFeed(me, 'explore');
      expect(ids(explore)).toEqual([visible.id]);
      expect(['DISCOVERY', 'TRENDING', 'SPORT_INTEREST']).toContain(explore.items[0]?.reason);

      // Home also shows your own (so a fresh post confirms the share worked); nothing invisible leaks.
      const home = await fetchFeed(me, 'home');
      expect(ids(home).sort()).toEqual([visible.id, own.id].sort());
      expect(home.items.find((i) => i.post.id === own.id)?.reason).toBe('OWN_POST');
    });

    it('home mixes followed authors (labelled) with discovery; explore excludes people you follow', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(t, me, friend);
      const friendPost = await pub(friend, 'friend');
      const strangerPost = await pub(stranger, 'stranger');
      const own = await pub(me, 'own');

      const home = await fetchFeed(me, 'home');
      const byId = new Map(home.items.map((i) => [i.post.id, i.reason]));
      expect(byId.get(friendPost.id)).toBe('FOLLOWED_AUTHOR');
      expect(byId.get(own.id)).toBe('OWN_POST');
      expect(byId.has(strangerPost.id)).toBe(true);
      expect(home.algorithmVersion).toBe('ranked-v1');

      const explore = await fetchFeed(me, 'explore');
      expect(ids(explore)).toEqual([strangerPost.id]);
      expect(explore.algorithmVersion).toBe('explore-v1');
    });

    it('a ranked refresh is exactly-once across pages and immune to later posts', async () => {
      const me = await signupUser(t);
      const authors = await Promise.all(Array.from({ length: 6 }, () => signupUser(t)));
      for (const a of authors) {
        await follow(t, me, a);
        for (let i = 0; i < 3; i++) {
          t.clock.advanceSeconds(1);
          await pub(a, `post ${i}`);
        }
      }
      const pages = await allPages(me, 'home', 5);
      const walked = pages.flatMap(ids);
      expect(pages.length).toBeGreaterThan(2);
      expect(walked).toHaveLength(18);
      expect(new Set(walked).size).toBe(walked.length); // no duplicates, nothing skipped

      // Pages of any size walk the same stored list.
      const first = await fetchFeed(me, 'home', '?limit=4');
      const expectedAll = (await allPages(me, 'home', 50)).flatMap(ids);
      expect([...walked].sort()).toEqual([...expectedAll].sort());

      // A post published after the refresh never enters the frozen list...
      const late = await pub(authors[0] as TestUser, 'published after the refresh');
      const rest = await allPagesFrom(me, 'home', first, 4);
      const frozen = [...ids(first), ...rest.flatMap(ids)];
      expect(frozen).not.toContain(late.id);
      expect(new Set(frozen).size).toBe(frozen.length);
      // ...and leads the next refresh.
      expect((await allPages(me, 'home', 50)).flatMap(ids)).toContain(late.id);
    });

    async function allPagesFrom(
      user: TestUser,
      surface: 'home' | 'explore',
      first: FeedPage,
      limit: number,
      between?: () => Promise<void>,
    ): Promise<FeedPage[]> {
      const pages: FeedPage[] = [];
      let cursor = first.nextCursor;
      while (cursor && pages.length < 50) {
        if (between) await between();
        const page = await fetchFeed(user, surface, `?limit=${limit}&cursor=${cursor}`);
        pages.push(page);
        cursor = page.nextCursor;
      }
      return pages;
    }

    it('re-checks visibility when a later page is served', async () => {
      const me = await signupUser(t);
      const authors = await Promise.all(Array.from({ length: 4 }, () => signupUser(t)));
      for (const a of authors) {
        await follow(t, me, a);
        t.clock.advanceSeconds(1);
        await pub(a);
      }
      const first = await fetchFeed(me, 'home', '?limit=1');
      expect(first.nextCursor).not.toBeNull();
      const shownAuthor = first.items[0]?.post.author.id;
      const [blocker, deleter, survivor] = authors.filter((a) => a.id !== shownAuthor) as [
        TestUser,
        TestUser,
        TestUser,
      ];
      const postOf = async (u: TestUser) =>
        (
          await t.platform.db
            .selectFrom('posts')
            .select('id')
            .where('authorId', '=', u.id)
            .executeTakeFirstOrThrow()
        ).id;

      // After the refresh: one author blocks me, one deletes their post.
      await api(t, blocker).put(`/users/${me.id}/block`);
      await api(t, deleter).del(`/posts/${await postOf(deleter)}`);

      const later = (await allPagesFrom(me, 'home', first, 10)).flatMap(ids);
      expect(later).toEqual([await postOf(survivor)]);
    });

    it('answers FEED_EXPIRED for stale, foreign or mismatched cursors and INVALID_CURSOR for junk', async () => {
      const me = await signupUser(t);
      const other = await signupUser(t);
      const author = await signupUser(t);
      for (let i = 0; i < 3; i++) await pub(author, `p${i}`);
      const first = await fetchFeed(me, 'explore', '?limit=1');
      const cursor = first.nextCursor as string;

      // Another user cannot continue my snapshot (and learns nothing about it).
      const foreign = await api(t, other).get(`/feed/explore?cursor=${cursor}`);
      expect(foreign.statusCode).toBe(410);
      expect(errorCode(foreign)).toBe('FEED_EXPIRED');

      // An explore cursor is not valid for home.
      const wrongSurface = await api(t, me).get(`/feed/home?cursor=${cursor}`);
      expect(wrongSurface.statusCode).toBe(400);
      expect(errorCode(wrongSurface)).toBe('INVALID_CURSOR');

      expect(errorCode(await api(t, me).get('/feed/home?cursor=not-a-cursor'))).toBe(
        'INVALID_CURSOR',
      );
      expect(errorCode(await api(t, me).get('/feed/following?cursor=bm9wZQ'))).toBe(
        'INVALID_CURSOR',
      );

      // After the TTL the snapshot is gone.
      t.clock.advanceSeconds((t.config.FEED_SNAPSHOT_TTL_MINUTES + 1) * 60);
      const me2 = await relogin(t, me);
      const expired = await api(t, me2).get(`/feed/explore?cursor=${cursor}`);
      expect(expired.statusCode).toBe(410);
      expect(errorCode(expired)).toBe('FEED_EXPIRED');
      // A refresh always works.
      expect((await api(t, me2).get('/feed/explore')).statusCode).toBe(200);
    });

    it('keeps sponsored content labelled, and never recommends it to under-18 viewers', async () => {
      const adult = await signupUser(t);
      const teen = await signupUser(t, { birthDate: '2011-03-01' });
      const brand = await signupUser(t);
      const organic = await pub(brand, 'organic');
      const sponsored = await pub(brand, 'new shoes', {
        sponsorship: { type: 'PAID_PARTNERSHIP', brandName: 'Acme Run' },
      });

      const adultFeed = await fetchFeed(adult, 'explore');
      expect(ids(adultFeed).sort()).toEqual([organic.id, sponsored.id].sort());
      const item = adultFeed.items.find((i) => i.post.id === sponsored.id);
      expect(item?.post.sponsorship).toMatchObject({ label: 'Paid partnership with Acme Run' });

      const teenFeed = await fetchFeed(teen, 'explore');
      expect(ids(teenFeed)).toEqual([organic.id]);
      // ...though a teen who FOLLOWS the brand still sees its (labelled) posts at home.
      await follow(t, teen, brand);
      expect(ids(await fetchFeed(teen, 'home'))).toContain(sponsored.id);
    });

    it('declared sports shape discovery even with personalization off', async () => {
      const me = await signupUser(t);
      const runner = await signupUser(t);
      const rider = await signupUser(t);
      const mk = async (u: TestUser, sport: string) => {
        const res = await api(t, u).post('/activities', {
          sport,
          startedAt: '2026-03-01T08:00:00Z',
          elapsedTimeS: 1800,
          visibility: 'PUBLIC',
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json<{ id: string }>().id;
      };
      await mk(runner, 'running');
      await mk(rider, 'cycling');
      await api(t, me).put('/me/sports', {
        items: [{ sport: 'cycling', relation: 'PARTICIPANT' }],
      });
      await api(t, me).patch('/me/settings', { personalizationEnabled: false });

      const page = await fetchFeed(me, 'explore');
      expect(page.items).toHaveLength(2);
      expect(page.items[0]?.post.author.id).toBe(rider.id);
      expect(page.items[0]?.reason).toBe('SPORT_INTEREST');
    });
  });

  describe('serving log', () => {
    it('records each served page and the per-item decision (reason, score, signals)', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      await follow(t, me, friend);
      const p = await pub(friend);

      const page = await fetchFeed(me, 'home');
      const request = await t.platform.db
        .selectFrom('feedRequests')
        .selectAll()
        .where('id', '=', page.requestId)
        .executeTakeFirstOrThrow();
      expect(request).toMatchObject({
        userId: me.id,
        surface: 'HOME',
        algorithmVersion: 'ranked-v1',
        itemCount: 1,
        pageOffset: 0,
      });
      const recs = await t.platform.db
        .selectFrom('recommendationEvents')
        .selectAll()
        .where('feedRequestId', '=', page.requestId)
        .execute();
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ postId: p.id, position: 0, reason: 'FOLLOWED_AUTHOR' });
      expect(recs[0]?.score).toBeGreaterThan(0);
      expect(Object.keys(recs[0]?.signals as object)).toContain('recency');

      // The chronological feed logs too (no scores).
      const chrono = await fetchFeed(me, 'following');
      const chronoRecs = await t.platform.db
        .selectFrom('recommendationEvents')
        .select(['score', 'reason'])
        .where('feedRequestId', '=', chrono.requestId)
        .execute();
      expect(chronoRecs).toEqual([{ score: null, reason: 'FOLLOWED_AUTHOR' }]);
    });

    it('can sample item-level logging down to zero without losing request attribution', async () => {
      await t.close();
      t = await createTestApp({ env: { RANKING_LOG_SAMPLE_RATE: '0' } });
      const me = await signupUser(t);
      const friend = await signupUser(t);
      await follow(t, me, friend);
      await pub(friend);
      const page = await fetchFeed(me, 'home');
      expect(page.items).toHaveLength(1);
      expect(
        await t.platform.db
          .selectFrom('feedRequests')
          .select('id')
          .where('id', '=', page.requestId)
          .executeTakeFirst(),
      ).toBeDefined();
      expect(
        await t.platform.db.selectFrom('recommendationEvents').select('postId').execute(),
      ).toHaveLength(0);
    });

    it('still serves the feed if the log cannot be written', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      await follow(t, me, friend);
      await pub(friend);
      await t.platform.db.schema.dropTable('recommendation_events').execute();
      const res = await api(t, me).get('/feed/home');
      expect(res.statusCode).toBe(200);
      expect(res.json<FeedPage>().items).toHaveLength(1);
    });
  });

  describe('efficiency', () => {
    it('uses a constant number of queries per page regardless of page size', async () => {
      const statements: string[] = [];
      await t.close();
      t = await createTestApp({
        onQuery: (e: LogEvent) => void statements.push(e.query.sql),
      });
      const me = await signupUser(t);
      const authors = await Promise.all(Array.from({ length: 4 }, () => signupUser(t)));
      for (const a of authors) await follow(t, me, a);

      const measure = async (surface: 'home' | 'following', n: number) => {
        // top up so the feed has at least n items
        const have = (await fetchFeed(me, surface, '?limit=50')).items.length;
        for (let i = have; i < n; i++) {
          t.clock.advanceSeconds(1);
          await pub(authors[i % authors.length] as TestUser, `post ${i}`);
        }
        const before = statements.length;
        const page = await fetchFeed(me, surface, `?limit=${n}`);
        expect(page.items.length).toBeGreaterThanOrEqual(Math.min(n, 3));
        return statements.length - before;
      };

      // Maxima: HOME_DIVERSITY caps 5 posts/author, 4 authors => at most 20 home items.
      for (const surface of ['following', 'home'] as const) {
        const small = await measure(surface, 4);
        const large = await measure(surface, 18);
        expect(large, `${surface}: ${small} vs ${large}`).toBe(small);
      }
    });
  });
});
