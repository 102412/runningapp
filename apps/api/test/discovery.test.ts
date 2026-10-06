import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, errorCode, relogin, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

interface Suggestions {
  items: Array<{
    user: { id: string; username: string };
    reason: string;
    mutualFollowers: number;
    primarySport: string | null;
  }>;
  nextCursor: string | null;
}
interface PostPage {
  items: Array<{ id: string; caption: string }>;
  nextCursor: string | null;
}

describe('discovery', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption: string, extra: Record<string, unknown> = {}) =>
    createPost(t, user, { caption, visibility: 'PUBLIC', ...extra }) as Promise<{ id: string }>;
  const suggestions = async (user: TestUser, query = '') =>
    (await api(t, user).get(`/discover/athletes${query}`)).json<Suggestions>();

  describe('who to follow', () => {
    it('suggests friends-of-friends, then shared sports, then creators and popular accounts', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      const mutual = await signupUser(t, { username: 'mutual_pal' });
      const runner = await signupUser(t, { username: 'fellow_runner' });
      const creator = await signupUser(t, { username: 'big_creator' });
      const popular = await signupUser(t, { username: 'popular_one' });
      const nobody = await signupUser(t, { username: 'quiet_one' });

      await follow(t, me, friend);
      await follow(t, friend, mutual);
      await api(t, me).put('/me/sports', {
        items: [{ sport: 'running', relation: 'PARTICIPANT' }],
      });
      await t.platform.db
        .updateTable('profiles')
        .set({ primarySportKey: 'running' })
        .where('userId', '=', runner.id)
        .execute();
      await t.platform.db
        .insertInto('creatorProfiles')
        .values({ userId: creator.id, category: 'COACH' })
        .execute();
      for (const u of [mutual, runner, creator, popular, friend])
        await pub(u, `hello from ${u.username}`);
      // `popular` has followers; `quiet_one` has no posts and must never be suggested.
      for (let i = 0; i < 3; i++) await follow(t, await signupUser(t), popular);

      const result = await suggestions(me);
      const order = result.items.map((i) => `${i.user.username}:${i.reason}`);
      expect(order[0]).toBe('mutual_pal:FOLLOWED_BY_FOLLOWING');
      expect(order[1]).toBe('fellow_runner:SAME_SPORT');
      expect(order).toContain('big_creator:CREATOR');
      expect(order).toContain('popular_one:POPULAR');
      expect(result.items[0]?.mutualFollowers).toBe(1);
      expect(result.items[1]?.primarySport).toBe('running');
      expect(result.items.map((i) => i.user.id)).not.toContain(nobody.id); // no posts
      expect(result.items.map((i) => i.user.id)).not.toContain(me.id);
      expect(result.items.map((i) => i.user.id)).not.toContain(friend.id); // already followed
    });

    it('excludes pending requests, blocked, opted-out and under-age accounts, and pages exactly once', async () => {
      const me = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const blocked = await signupUser(t);
      const blocker = await signupUser(t);
      const ghost = await signupUser(t);
      const teen = await signupUser(t, { birthDate: '2011-03-01' });
      const ok = await Promise.all(Array.from({ length: 5 }, () => signupUser(t)));
      await api(t, me).post(`/users/${priv.id}/follow`); // pending request
      await api(t, me).put(`/users/${blocked.id}/block`);
      await api(t, blocker).put(`/users/${me.id}/block`);
      await t.platform.db
        .updateTable('profiles')
        .set({ discoverable: false })
        .where('userId', '=', ghost.id)
        .execute();
      for (const u of [priv, blocked, blocker, ghost, ...ok]) await pub(u, 'hi');
      await createPost(t, teen, { caption: 'hi', visibility: 'FOLLOWERS' });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Suggestions = await suggestions(
          me,
          `?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.items.map((i) => i.user.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual(ok.map((u) => u.id).sort());
    });
  });

  describe('topics', () => {
    it('trends only topics used by several people recently, counting public posts only', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      const c = await signupUser(t);
      await pub(a, 'p1', { topics: ['gravel'] });
      await pub(b, 'p2', { topics: ['gravel'] });
      await pub(b, 'p3', { topics: ['gravel'] });
      await createPost(t, c, {
        caption: 'private-ish',
        visibility: 'FOLLOWERS',
        topics: ['gravel'],
      });
      await pub(a, 'p4', { topics: ['solo'] });
      await pub(a, 'p5', { topics: ['solo'] }); // one author only: not trending
      await pub(a, 'old1', { topics: ['stale'] });
      await pub(b, 'old2', { topics: ['stale'] });
      await t.platform.db
        .updateTable('posts')
        .set({ publishedAt: new Date(t.clock.now().getTime() - 30 * 86_400_000) })
        .where('caption', 'in', ['old1', 'old2'])
        .execute();

      const res = await api(t).get('/discover/topics'); // anonymous is fine: public data only
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [{ slug: 'gravel', postCount: 3, authorCount: 2 }] });
      expect((await api(t).get('/discover/topics?limit=0')).statusCode).toBe(422);
    });

    it('shows a topic page: 404 for unknown, public posts for visitors, more for followers', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t);
      const first = await pub(author, 'first #gravel');
      t.clock.advanceSeconds(1);
      const second = await pub(author, 'second', { topics: ['gravel'] });
      t.clock.advanceSeconds(1);
      const followersOnly = await createPost(t, author, {
        caption: 'followers #gravel',
        visibility: 'FOLLOWERS',
      });

      expect(errorCode(await api(t).get('/topics/nope'))).toBe('TOPIC_NOT_FOUND');
      expect(errorCode(await api(t).get('/topics/nope/posts'))).toBe('TOPIC_NOT_FOUND');
      expect((await api(t).get('/topics/gravel')).json()).toEqual({ slug: 'gravel', postCount: 2 });
      expect((await api(t).get('/topics/%23Gravel')).json()).toEqual({
        slug: 'gravel',
        postCount: 2,
      });

      const anon = (await api(t).get('/topics/gravel/posts')).json<PostPage>();
      expect(anon.items.map((p) => p.id)).toEqual([second.id, first.id]);

      await follow(t, me, author);
      const asFollower = (await api(t, me).get('/topics/gravel/posts?limit=2')).json<PostPage>();
      expect(asFollower.items.map((p) => p.id)).toEqual([followersOnly.id, second.id]);
      const next = (
        await api(t, me).get(`/topics/gravel/posts?limit=2&cursor=${asFollower.nextCursor}`)
      ).json<PostPage>();
      expect(next.items.map((p) => p.id)).toEqual([first.id]);
      expect(next.nextCursor).toBeNull();
    });

    it('keeps working after the clock moves on', async () => {
      const me = await signupUser(t);
      t.clock.advanceSeconds(3600);
      const fresh = await relogin(t, me);
      expect((await api(t, fresh).get('/discover/athletes')).statusCode).toBe(200);
    });
  });
});
