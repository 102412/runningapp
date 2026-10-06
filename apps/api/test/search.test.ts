import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SearchContext,
  SearchHits,
  SearchProvider,
  TopicHit,
} from '../src/modules/search/provider';
import { api, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

interface UserPage {
  items: Array<{ id: string; username: string }>;
  nextCursor: string | null;
}
interface PostPage {
  items: Array<{ id: string; caption: string }>;
  nextCursor: string | null;
}
interface TopicPage {
  items: Array<{ slug: string; postCount: number }>;
  nextCursor: string | null;
}

describe('search', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption: string, extra: Record<string, unknown> = {}) =>
    createPost(t, user, { caption, visibility: 'PUBLIC', ...extra }) as Promise<{ id: string }>;
  const enc = encodeURIComponent;
  const users = async (viewer: TestUser, q: string, query = '') =>
    (await api(t, viewer).get(`/search/users?q=${enc(q)}${query}`)).json<UserPage>();
  const posts = async (viewer: TestUser, q: string, query = '') =>
    (await api(t, viewer).get(`/search/posts?q=${enc(q)}${query}`)).json<PostPage>();
  const names = (page: UserPage) => page.items.map((u) => u.username);

  it('requires authentication and a sensible query', async () => {
    const me = await signupUser(t);
    for (const path of ['/search', '/search/users', '/search/posts', '/search/topics']) {
      expect((await api(t).get(`${path}?q=abc`)).statusCode, path).toBe(401);
      expect(errorCode(await api(t, me).get(`${path}?q=a`)), `${path} short`).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await api(t, me).get(`${path}`)), `${path} missing`).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await api(t, me).get(`${path}?q=${'x'.repeat(101)}`)), `${path} long`).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  describe('users', () => {
    it('ranks exact and prefix matches first, matches display names, and tolerates typos', async () => {
      const me = await signupUser(t);
      const alice = await signupUser(t, { username: 'alice', displayName: 'Alice Johnson' });
      const alicia = await signupUser(t, { username: 'alicia_k', displayName: 'Alicia K' });
      await signupUser(t, { username: 'malice_x', displayName: 'Someone Else' });
      await signupUser(t, { username: 'bob_stone', displayName: 'Bob Stone' });

      expect(names(await users(me, 'alice')).sort()).toEqual(['alice', 'alicia_k', 'malice_x']);
      expect(names(await users(me, 'alice'))[0]).toBe('alice');
      expect(names(await users(me, '@alice'))[0]).toBe('alice'); // leading @ ignored
      expect(names(await users(me, 'ALICE'))[0]).toBe('alice'); // case-insensitive
      expect(names(await users(me, 'johnson'))).toEqual(['alice']); // by display name
      expect(names(await users(me, 'alise'))).toContain('alice'); // typo
      expect(names(await users(me, 'zzzzzz'))).toEqual([]);
      expect(alicia.id).toBeDefined();
      expect(alice.id).toBeDefined();
    });

    it('treats LIKE wildcards in the query as plain text', async () => {
      const me = await signupUser(t);
      await signupUser(t, { username: 'carol_one' });
      expect(names(await users(me, '%%'))).toEqual([]);
      expect(names(await users(me, '__'))).toEqual([]);
      expect(names(await users(me, 'carol_'))).toEqual(['carol_one']);
    });

    it('never surfaces blocked, suspended, opted-out, or under-age accounts; includes private ones', async () => {
      const me = await signupUser(t);
      await signupUser(t, { username: 'dana_open' });
      await signupUser(t, { username: 'dana_private', isPrivate: true });
      const ghost = await signupUser(t, { username: 'dana_ghost' });
      const blocked = await signupUser(t, { username: 'dana_blocked' });
      const blocker = await signupUser(t, { username: 'dana_blocker' });
      const suspended = await signupUser(t, { username: 'dana_suspended' });
      await signupUser(t, { username: 'dana_teen', birthDate: '2011-03-01' });
      await t.platform.db
        .updateTable('profiles')
        .set({ discoverable: false })
        .where('userId', '=', ghost.id)
        .execute();
      await t.platform.db
        .updateTable('users')
        .set({ status: 'SUSPENDED', suspendedAt: t.clock.now() })
        .where('id', '=', suspended.id)
        .execute();
      await api(t, me).put(`/users/${blocked.id}/block`);
      await api(t, blocker).put(`/users/${me.id}/block`);

      expect(names(await users(me, 'dana')).sort()).toEqual(['dana_open', 'dana_private']);

      // An opted-out account is still findable by the people who follow it.
      await follow(t, me, ghost);
      expect(names(await users(me, 'dana')).sort()).toEqual([
        'dana_ghost',
        'dana_open',
        'dana_private',
      ]);
    });

    it('pages exactly once and rejects forged cursors', async () => {
      const me = await signupUser(t);
      for (let i = 1; i <= 7; i++) await signupUser(t, { username: `runner0${i}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: UserPage = await users(
          me,
          'runner',
          `&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...names(page));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(errorCode(await api(t, me).get('/search/users?q=runner&cursor=garbage'))).toBe(
        'INVALID_CURSOR',
      );
    });
  });

  describe('posts', () => {
    it('finds captions (prefix, multi-word) and tagged posts, newest relevant first', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t);
      const gravel = await pub(author, 'Sunrise gravel ride #gravel');
      await pub(author, 'Morning trail run');
      const tagged = await pub(author, 'big day out', { topics: ['marathon'] });

      expect((await posts(me, 'gravel')).items.map((p) => p.id)).toEqual([gravel.id]);
      expect((await posts(me, 'grav')).items.map((p) => p.id)).toEqual([gravel.id]); // prefix
      expect((await posts(me, '#gravel')).items.map((p) => p.id)).toEqual([gravel.id]);
      expect((await posts(me, 'trail run')).items).toHaveLength(1);
      expect((await posts(me, 'marathon')).items.map((p) => p.id)).toEqual([tagged.id]); // tag only
      expect((await posts(me, 'nothingmatches')).items).toEqual([]);
    });

    it('is safe against tsquery syntax in user input', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t);
      await pub(author, 'run fast');
      for (const q of ['run & !(', 'ru:* | (', "'); drop table posts; --", '!!!', '(((', '& |']) {
        const res = await api(t, me).get(`/search/posts?q=${enc(q)}`);
        expect(res.statusCode, q).toBe(200);
      }
      expect((await posts(me, 'run & !(')).items).toHaveLength(1);
    });

    it('applies the same visibility rules as feeds', async () => {
      const me = await signupUser(t);
      const open = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const ghost = await signupUser(t);
      const blocked = await signupUser(t);
      const friend = await signupUser(t);
      await t.platform.db
        .updateTable('profiles')
        .set({ discoverable: false })
        .where('userId', '=', ghost.id)
        .execute();

      const visible = await pub(open, 'findme public');
      await createPost(t, open, { caption: 'findme followers', visibility: 'FOLLOWERS' });
      await pub(priv, 'findme private account');
      await pub(ghost, 'findme opted out');
      await pub(blocked, 'findme blocked');
      const hidden = await pub(open, 'findme hidden');
      const deleted = await pub(open, 'findme deleted');
      const own = await createPost(t, me, { caption: 'findme mine', visibility: 'PRIVATE' });
      const friendFollowers = await createPost(t, friend, {
        caption: 'findme friend only',
        visibility: 'FOLLOWERS',
      });
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'HIDDEN' })
        .where('id', '=', hidden.id)
        .execute();
      await api(t, open).del(`/posts/${deleted.id}`);
      await api(t, me).put(`/users/${blocked.id}/block`);

      const before = (await posts(me, 'findme')).items.map((p) => p.id).sort();
      expect(before).toEqual([visible.id, own.id].sort());

      // Following makes followers-only content and an opted-out account's posts searchable.
      await follow(t, me, friend);
      await follow(t, me, ghost);
      const after = (await posts(me, 'findme')).items.map((p) => p.caption).sort();
      expect(after).toEqual(
        ['findme public', 'findme mine', 'findme friend only', 'findme opted out'].sort(),
      );
      expect(friendFollowers.id).toBeDefined();
    });
  });

  describe('topics and overview', () => {
    it('lists topics that public posts use, with capped public counts', async () => {
      const me = await signupUser(t);
      const a = await signupUser(t);
      const b = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      await pub(a, 'one', { topics: ['gravel'] });
      await pub(b, 'two', { topics: ['gravel'] });
      await pub(b, 'three', { topics: ['gravelbikes'] });
      await createPost(t, a, { caption: 'followers', visibility: 'FOLLOWERS', topics: ['gravel'] });
      await pub(priv, 'secret', { topics: ['gravelsecret'] });

      const result = (await api(t, me).get('/search/topics?q=grav')).json<TopicPage>();
      expect(result.items).toEqual([
        { slug: 'gravel', postCount: 2 },
        { slug: 'gravelbikes', postCount: 1 },
      ]);
      expect(
        (await api(t, me).get('/search/topics?q=%23grav')).json<TopicPage>().items,
      ).toHaveLength(2);
      expect((await api(t, me).get('/search/topics?q=zzz')).json<TopicPage>().items).toEqual([]);
    });

    it('returns a few of each kind in one call', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t, { username: 'gravelgrinder' });
      await pub(author, 'gravel season', { topics: ['gravel'] });
      const body = (await api(t, me).get('/search?q=gravel')).json<{
        users: Array<{ username: string }>;
        topics: Array<{ slug: string }>;
        posts: Array<{ caption: string }>;
      }>();
      expect(body.users.map((u) => u.username)).toEqual(['gravelgrinder']);
      expect(body.topics.map((x) => x.slug)).toEqual(['gravel']);
      expect(body.posts).toHaveLength(1);
    });
  });

  describe('provider isolation', () => {
    it('never returns what the database says the viewer may not see, even if the index is stale', async () => {
      await t.close();
      const stale: { userIds: string[]; postIds: string[] } = { userIds: [], postIds: [] };
      const provider: SearchProvider = {
        name: 'stale-external-index',
        searchUsers: async (_c: SearchContext): Promise<SearchHits<string>> => ({
          hits: stale.userIds,
          hasMore: false,
        }),
        searchPosts: async (): Promise<SearchHits<string>> => ({
          hits: stale.postIds,
          hasMore: false,
        }),
        searchTopics: async (): Promise<SearchHits<TopicHit>> => ({ hits: [], hasMore: false }),
      };
      t = await createTestApp({ overrides: { search: provider } });

      const me = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const blocked = await signupUser(t);
      const teen = await signupUser(t, { birthDate: '2011-03-01' });
      const open = await signupUser(t);
      const privatePost = await createPost(t, priv, { caption: 'secret', visibility: 'FOLLOWERS' });
      const draft = await createPost(t, open, { caption: 'draft', publish: false });
      const okPost = await pub(open, 'fine');
      await api(t, me).put(`/users/${blocked.id}/block`);

      stale.userIds = [blocked.id, teen.id, open.id];
      stale.postIds = [privatePost.id, draft.id, okPost.id];
      expect((await users(me, 'anything')).items.map((u) => u.id)).toEqual([open.id]);
      expect((await posts(me, 'anything')).items.map((p) => p.id)).toEqual([okPost.id]);
    });
  });
});
