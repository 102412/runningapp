import type { LogEvent } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

/**
 * N+1 guard for every paginated listing: the number of SQL statements to serve a page must not
 * depend on how many items are on it. (Feeds and post grids have their own checks next to their
 * features; this covers the rest.)
 */
describe('query budget: statements per page do not grow with page size', () => {
  let t: TestApp;
  const statements: string[] = [];
  let pool: TestUser[];
  let owner: TestUser;
  let viewer: TestUser;
  let staff: TestUser;
  let ownerPostId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp({ onQuery: (e: LogEvent) => void statements.push(e.query.sql) });
    pool = [];
    for (let i = 0; i < 24; i++) pool.push(await signupUser(t, { username: `budget_user_${i}` }));
    owner = pool[0] as TestUser;
    viewer = await signupUser(t);
    staff = await signupUser(t);
    await t.platform.db
      .updateTable('users')
      .set({ role: 'MODERATOR' })
      .where('id', '=', staff.id)
      .execute();

    // Everyone posts something public about gravel; the owner gets reactions, comments, followers.
    const posts: Array<{ id: string }> = [];
    for (const u of pool) {
      posts.push(
        (await createPost(t, u, {
          caption: `gravel ride by ${u.username}`,
          visibility: 'PUBLIC',
          topics: ['gravel'],
        })) as { id: string },
      );
    }
    ownerPostId = (posts[0] as { id: string }).id;
    // A dozen related topics (for topic search) ...
    for (const [i, u] of pool.slice(0, 12).entries()) {
      await createPost(t, u, {
        caption: `topic post ${i}`,
        visibility: 'PUBLIC',
        topics: [`gravelbikes${i}`],
      });
    }
    ids.owner = owner.id;
    for (const [i, u] of pool.entries()) {
      if (u.id === owner.id) continue;
      await follow(t, u, owner);
      await api(t, u).put(`/posts/${ownerPostId}/reaction`, { type: 'LIKE' });
      const c = (
        await api(t, u).post(`/posts/${ownerPostId}/comments`, { body: `nice ${i}` })
      ).json<{ id: string }>();
      if (i % 3 === 0)
        await api(t, owner).post(`/posts/${ownerPostId}/comments`, {
          body: 'thanks',
          parentId: c.id,
        });
      // The owner bookmarks everyone's post, and each user reports the NEXT user's post.
      await api(t, owner).put(`/posts/${(posts[i] as { id: string }).id}/bookmark`);
      await api(t, u).post('/reports', {
        targetType: 'POST',
        targetId: (posts[(i + 1) % pool.length] as { id: string }).id,
        reason: 'SPAM',
      });
    }
    // ... and one person who has filed plenty of reports (for "my reports").
    for (const [j, post] of posts.entries()) {
      if (j === 1 || j === 2) continue; // own post / already reported above
      await api(t, pool[1]).post('/reports', {
        targetType: 'POST',
        targetId: post.id,
        reason: 'OTHER',
      });
    }
  });
  afterAll(async () => {
    await t.close();
  });

  interface Scenario {
    name: string;
    as: () => TestUser;
    url: (limit: number) => string;
  }
  const scenarios: Scenario[] = [
    {
      name: 'search users',
      as: () => viewer,
      url: (l) => `/search/users?q=budget_user&limit=${l}`,
    },
    { name: 'search posts', as: () => viewer, url: (l) => `/search/posts?q=gravel&limit=${l}` },
    { name: 'search topics', as: () => viewer, url: (l) => `/search/topics?q=grav&limit=${l}` },
    { name: 'topic posts', as: () => viewer, url: (l) => `/topics/gravel/posts?limit=${l}` },
    { name: 'notifications', as: () => owner, url: (l) => `/notifications?limit=${l}` },
    { name: 'comments', as: () => viewer, url: (l) => `/posts/${ownerPostId}/comments?limit=${l}` },
    {
      name: 'reactions',
      as: () => viewer,
      url: (l) => `/posts/${ownerPostId}/reactions?limit=${l}`,
    },
    { name: 'followers', as: () => viewer, url: (l) => `/users/${ids.owner}/followers?limit=${l}` },
    { name: 'bookmarks', as: () => owner, url: (l) => `/me/bookmarks?limit=${l}` },
    { name: 'who to follow', as: () => viewer, url: (l) => `/discover/athletes?limit=${l}` },
    { name: 'moderation queue', as: () => staff, url: (l) => `/admin/reports?limit=${l}` },
    { name: 'my reports', as: () => pool[1] as TestUser, url: (l) => `/me/reports?limit=${l}` },
  ];

  async function measure(s: Scenario, limit: number): Promise<{ queries: number; items: number }> {
    await api(t, s.as()).get(s.url(limit)); // warm (prepared statements, lazy init)
    const before = statements.length;
    const res = await api(t, s.as()).get(s.url(limit));
    expect(res.statusCode, `${s.name}: ${res.body}`).toBe(200);
    const body = res.json<{ items: unknown[] }>();
    return { queries: statements.length - before, items: body.items.length };
  }

  for (const s of scenarios) {
    it(s.name, async () => {
      const small = await measure(s, 3);
      const large = await measure(s, 20);
      expect(small.items, `${s.name} small page`).toBeGreaterThan(0);
      expect(large.items, `${s.name} large page`).toBeGreaterThan(small.items);
      expect(
        large.queries,
        `${s.name}: ${small.queries} queries for ${small.items} items vs ${large.queries} for ${large.items}`,
      ).toBe(small.queries);
    });
  }
});
