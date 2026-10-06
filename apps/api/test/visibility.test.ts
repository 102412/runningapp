import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRelations } from '../src/modules/social/relations';
import { accountVisibleTo, contentVisibleTo } from '../src/modules/social/visibility';
import { signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';

type Viewer = 'anonymous' | 'self' | 'follower' | 'stranger' | 'blockedByAuthor' | 'blockedAuthor';
type Vis = 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';

/**
 * The visibility predicates are the only thing standing between private content and the wrong
 * eyes. This enumerates the full truth table: viewer relationship x content visibility x
 * account privacy x author status.
 */
describe('contentVisibleTo / accountVisibleTo (truth table)', () => {
  let t: TestApp;
  const people: Record<string, TestUser> = {};
  beforeAll(async () => {
    t = await createTestApp();
    for (const name of [
      'pubAuthor',
      'privAuthor',
      'suspAuthor',
      'follower',
      'stranger',
      'blockedByAuthor',
      'blockedAuthor',
    ]) {
      people[name] = await signupUser(t);
    }
    const db = t.platform.db;
    await db
      .updateTable('profiles')
      .set({ accountVisibility: 'PRIVATE' })
      .where('userId', '=', id('privAuthor'))
      .execute();
    await db
      .updateTable('users')
      .set({ status: 'SUSPENDED', suspendedAt: new Date() })
      .where('id', '=', id('suspAuthor'))
      .execute();
    for (const author of ['pubAuthor', 'privAuthor', 'suspAuthor']) {
      await db
        .insertInto('follows')
        .values({ followerId: id('follower'), followeeId: id(author) })
        .execute();
      await db
        .insertInto('blocks')
        .values({ blockerId: id(author), blockedId: id('blockedByAuthor') })
        .execute();
      await db
        .insertInto('blocks')
        .values({ blockerId: id('blockedAuthor'), blockedId: id(author) })
        .execute();
    }
  });
  afterAll(async () => {
    await t.close();
  });

  function id(name: string): string {
    const p = people[name];
    if (!p) throw new Error(`unknown person ${name}`);
    return p.id;
  }

  function viewerId(viewer: Viewer, author: string): string | null {
    switch (viewer) {
      case 'anonymous':
        return null;
      case 'self':
        return id(author);
      case 'follower':
        return id('follower');
      case 'stranger':
        return id('stranger');
      case 'blockedByAuthor':
        return id('blockedByAuthor');
      case 'blockedAuthor':
        return id('blockedAuthor');
    }
  }

  async function visible(author: string, viewer: Viewer, visibility: Vis): Promise<boolean> {
    const v = viewerId(viewer, author);
    const pred = contentVisibleTo(v, {
      authorId: 'au.id',
      authorStatus: 'au.status',
      authorAccountVisibility: 'ap.account_visibility',
      visibility: 'c.visibility',
    });
    const res = await sql<{ ok: boolean }>`
      select ${pred} as ok
        from (select ${visibility}::content_visibility as visibility) c
        join users au on au.id = ${id(author)}
        join profiles ap on ap.user_id = au.id`.execute(t.platform.db);
    return res.rows[0]?.ok ?? false;
  }

  const expectations: Array<[string, Viewer, Record<Vis, boolean>]> = [
    // public account
    ['pubAuthor', 'anonymous', { PUBLIC: true, FOLLOWERS: false, PRIVATE: false }],
    ['pubAuthor', 'stranger', { PUBLIC: true, FOLLOWERS: false, PRIVATE: false }],
    ['pubAuthor', 'follower', { PUBLIC: true, FOLLOWERS: true, PRIVATE: false }],
    ['pubAuthor', 'self', { PUBLIC: true, FOLLOWERS: true, PRIVATE: true }],
    ['pubAuthor', 'blockedByAuthor', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    ['pubAuthor', 'blockedAuthor', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    // private account: PUBLIC content is still followers-only
    ['privAuthor', 'anonymous', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    ['privAuthor', 'stranger', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    ['privAuthor', 'follower', { PUBLIC: true, FOLLOWERS: true, PRIVATE: false }],
    ['privAuthor', 'self', { PUBLIC: true, FOLLOWERS: true, PRIVATE: true }],
    ['privAuthor', 'blockedByAuthor', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    // suspended author: invisible to everyone but themselves, followers included
    ['suspAuthor', 'follower', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    ['suspAuthor', 'anonymous', { PUBLIC: false, FOLLOWERS: false, PRIVATE: false }],
    ['suspAuthor', 'self', { PUBLIC: true, FOLLOWERS: true, PRIVATE: true }],
  ];

  for (const [author, viewer, expected] of expectations) {
    for (const vis of ['PUBLIC', 'FOLLOWERS', 'PRIVATE'] as const) {
      it(`${author} / ${vis} content seen by ${viewer} -> ${expected[vis] ? 'VISIBLE' : 'hidden'}`, async () => {
        expect(await visible(author, viewer, vis)).toBe(expected[vis]);
      });
    }
  }

  it('accountVisibleTo hides blocked pairs and non-active accounts, but never from self', async () => {
    const check = async (viewer: string | null, author: string): Promise<boolean> => {
      const pred = accountVisibleTo(viewer, { authorId: 'au.id', authorStatus: 'au.status' });
      const res = await sql<{
        ok: boolean;
      }>`select ${pred} as ok from users au where au.id = ${id(author)}`.execute(t.platform.db);
      return res.rows[0]?.ok ?? false;
    };
    expect(await check(null, 'pubAuthor')).toBe(true);
    expect(await check(id('stranger'), 'privAuthor')).toBe(true); // private accounts have visible headers
    expect(await check(id('blockedByAuthor'), 'pubAuthor')).toBe(false);
    expect(await check(id('blockedAuthor'), 'pubAuthor')).toBe(false);
    expect(await check(null, 'suspAuthor')).toBe(false);
    expect(await check(id('suspAuthor'), 'suspAuthor')).toBe(true);
  });

  it('loadRelations answers for many users in a bounded number of queries', async () => {
    const queries: string[] = [];
    const counted = await createTestApp({ onQuery: (e) => queries.push(e.query.sql) });
    try {
      const viewer = await signupUser(counted);
      const others = await Promise.all(Array.from({ length: 10 }, () => signupUser(counted)));
      for (const o of others.slice(0, 4)) {
        await counted.platform.db
          .insertInto('follows')
          .values({ followerId: viewer.id, followeeId: o.id })
          .execute();
      }
      queries.length = 0;
      const rel = await loadRelations(
        counted.platform.db,
        viewer.id,
        others.map((o) => o.id),
      );
      expect(queries.length).toBeLessThanOrEqual(3); // constant, independent of the number of users
      expect([...rel.values()].filter((r) => r.relationship === 'FOLLOWING')).toHaveLength(4);
    } finally {
      await counted.close();
    }
  });
});
