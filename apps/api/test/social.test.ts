import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';

describe('social graph', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  async function counts(u: TestUser): Promise<{ followers: number; following: number }> {
    const p = (await api(t, u).get(`/users/${u.id}`)).json();
    return { followers: p.counts.followers, following: p.counts.following };
  }

  describe('following public accounts', () => {
    it('follows immediately, updates both counters, and is idempotent', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      const first = await api(t, a).post(`/users/${b.id}/follow`);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ relationship: 'FOLLOWING' });
      await api(t, a).post(`/users/${b.id}/follow`);
      await api(t, a).post(`/users/${b.id}/follow`);

      expect(await counts(a)).toEqual({ followers: 0, following: 1 });
      expect(await counts(b)).toEqual({ followers: 1, following: 0 });

      const profile = (await api(t, a).get(`/users/${b.id}`)).json();
      expect(profile.viewer).toMatchObject({
        relationship: 'FOLLOWING',
        followsYou: false,
        isSelf: false,
      });
      const reverse = (await api(t, b).get(`/users/${a.id}`)).json();
      expect(reverse.viewer).toMatchObject({ relationship: 'NONE', followsYou: true });
    });

    it('unfollows idempotently and restores counters', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      await api(t, a).post(`/users/${b.id}/follow`);
      expect((await api(t, a).del(`/users/${b.id}/follow`)).statusCode).toBe(204);
      expect((await api(t, a).del(`/users/${b.id}/follow`)).statusCode).toBe(204);
      expect(await counts(b)).toEqual({ followers: 0, following: 0 });
    });

    it('rejects self-follow and unknown users', async () => {
      const a = await signupUser(t);
      expect(errorCode(await api(t, a).post(`/users/${a.id}/follow`))).toBe(
        'SELF_ACTION_NOT_ALLOWED',
      );
      expect(
        errorCode(await api(t, a).post('/users/018f0000-0000-7000-8000-000000000000/follow')),
      ).toBe('USER_NOT_FOUND');
    });

    it('concurrent follow calls create exactly one edge and one count', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => api(t, a).post(`/users/${b.id}/follow`)),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(await counts(b)).toEqual({ followers: 1, following: 0 });
    });

    it('lists followers and following with cursor pagination and no duplicates', async () => {
      const star = await signupUser(t);
      const fans: TestUser[] = [];
      for (let i = 0; i < 5; i++) {
        const f = await signupUser(t);
        fans.push(f);
        await api(t, f).post(`/users/${star.id}/follow`);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await api(t, star).get(
          `/users/${star.id}/followers?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(res.statusCode).toBe(200);
        const body = res.json();
        seen.push(...body.items.map((u: { id: string }) => u.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(5);
      expect(new Set(seen)).toEqual(new Set(fans.map((f) => f.id)));
      expect(errorCode(await api(t, star).get(`/users/${star.id}/followers?cursor=garbage`))).toBe(
        'INVALID_CURSOR',
      );
    });
  });

  describe('private accounts', () => {
    it('require approval: request, accept, notify, and then follow', async () => {
      const requester = await signupUser(t);
      const owner = await signupUser(t, { isPrivate: true });

      const res = await api(t, requester).post(`/users/${owner.id}/follow`);
      expect(res.json()).toEqual({ relationship: 'REQUESTED' });
      expect((await api(t, requester).get(`/users/${owner.id}`)).json().viewer.relationship).toBe(
        'REQUESTED',
      );
      expect(await counts(owner)).toEqual({ followers: 0, following: 0 });

      const pending = (await api(t, owner).get('/me/follow-requests')).json();
      expect(pending.items).toHaveLength(1);
      expect(pending.items[0].user.id).toBe(requester.id);
      expect(
        (await api(t, owner).get(`/users/${requester.id}`)).json().viewer.hasPendingRequestFromThem,
      ).toBe(true);

      const reqNotif = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', owner.id)
        .execute();
      expect(reqNotif.map((n) => n.type)).toContain('FOLLOW_REQUEST');

      expect(
        (await api(t, owner).post(`/me/follow-requests/${pending.items[0].id}/accept`)).statusCode,
      ).toBe(204);
      expect(await counts(owner)).toEqual({ followers: 1, following: 0 });
      expect((await api(t, requester).get(`/users/${owner.id}`)).json().viewer.relationship).toBe(
        'FOLLOWING',
      );

      const after = await t.platform.db
        .selectFrom('notifications')
        .select(['recipientId', 'type'])
        .execute();
      expect(
        after.some((n) => n.recipientId === requester.id && n.type === 'FOLLOW_ACCEPTED'),
      ).toBe(true);
      expect(after.some((n) => n.recipientId === owner.id && n.type === 'FOLLOW_REQUEST')).toBe(
        false,
      ); // retracted
    });

    it('reject is silent to the requester and can be re-requested', async () => {
      const requester = await signupUser(t);
      const owner = await signupUser(t, { isPrivate: true });
      await api(t, requester).post(`/users/${owner.id}/follow`);
      const pending = (await api(t, owner).get('/me/follow-requests')).json();
      expect(
        (await api(t, owner).post(`/me/follow-requests/${pending.items[0].id}/reject`)).statusCode,
      ).toBe(204);

      expect((await api(t, requester).get(`/users/${owner.id}`)).json().viewer.relationship).toBe(
        'NONE',
      );
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', requester.id)
        .execute();
      expect(notes).toEqual([]); // no "rejected" notification
      expect((await api(t, requester).post(`/users/${owner.id}/follow`)).json()).toEqual({
        relationship: 'REQUESTED',
      });
    });

    it('only the target can act on a request; stale ids 404', async () => {
      const requester = await signupUser(t);
      const owner = await signupUser(t, { isPrivate: true });
      const stranger = await signupUser(t);
      await api(t, requester).post(`/users/${owner.id}/follow`);
      const id = (await api(t, owner).get('/me/follow-requests')).json().items[0].id as string;
      expect(errorCode(await api(t, stranger).post(`/me/follow-requests/${id}/accept`))).toBe(
        'FOLLOW_REQUEST_NOT_FOUND',
      );
      expect(errorCode(await api(t, requester).post(`/me/follow-requests/${id}/accept`))).toBe(
        'FOLLOW_REQUEST_NOT_FOUND',
      );
      expect((await api(t, owner).post(`/me/follow-requests/${id}/accept`)).statusCode).toBe(204);
      expect(errorCode(await api(t, owner).post(`/me/follow-requests/${id}/accept`))).toBe(
        'FOLLOW_REQUEST_NOT_FOUND',
      );
    });

    it('requester can withdraw a pending request', async () => {
      const requester = await signupUser(t);
      const owner = await signupUser(t, { isPrivate: true });
      await api(t, requester).post(`/users/${owner.id}/follow`);
      await api(t, requester).del(`/users/${owner.id}/follow`);
      expect((await api(t, owner).get('/me/follow-requests')).json().items).toEqual([]);
    });

    it('hide follower lists from non-followers (ACCOUNT_PRIVATE) but show them to followers and self', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      await t.platform.db
        .insertInto('follows')
        .values({ followerId: follower.id, followeeId: owner.id })
        .execute();

      const denied = await api(t, stranger).get(`/users/${owner.id}/followers`);
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe('ACCOUNT_PRIVATE');
      expect((await api(t, follower).get(`/users/${owner.id}/followers`)).statusCode).toBe(200);
      expect((await api(t, owner).get(`/users/${owner.id}/following`)).statusCode).toBe(200);
    });

    it('going PUBLIC approves every pending request atomically', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const r1 = await signupUser(t);
      const r2 = await signupUser(t);
      await api(t, r1).post(`/users/${owner.id}/follow`);
      await api(t, r2).post(`/users/${owner.id}/follow`);

      expect(
        (await api(t, owner).patch('/me/settings', { accountVisibility: 'PUBLIC' })).statusCode,
      ).toBe(200);
      expect(await counts(owner)).toEqual({ followers: 2, following: 0 });
      expect((await api(t, owner).get('/me/follow-requests')).json().items).toEqual([]);
      const note = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', r1.id)
        .execute();
      expect(note.map((n) => n.type)).toContain('FOLLOW_ACCEPTED');
    });

    it('owner can remove a follower, who then must ask again', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const f = await signupUser(t);
      await t.platform.db
        .insertInto('follows')
        .values({ followerId: f.id, followeeId: owner.id })
        .execute();
      expect((await api(t, owner).del(`/me/followers/${f.id}`)).statusCode).toBe(204);
      expect(await counts(owner)).toEqual({ followers: 0, following: 0 });
      expect((await api(t, f).post(`/users/${owner.id}/follow`)).json()).toEqual({
        relationship: 'REQUESTED',
      });
    });
  });

  describe('blocking', () => {
    it('severs follows both ways and hides each account from the other', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      await api(t, a).post(`/users/${b.id}/follow`);
      await api(t, b).post(`/users/${a.id}/follow`);
      expect(await counts(a)).toEqual({ followers: 1, following: 1 });

      expect((await api(t, a).put(`/users/${b.id}/block`)).statusCode).toBe(204);
      expect((await api(t, a).put(`/users/${b.id}/block`)).statusCode).toBe(204); // idempotent

      // Neither can see the other: indistinguishable from a non-existent account.
      expect(errorCode(await api(t, b).get(`/users/${a.id}`))).toBe('USER_NOT_FOUND');
      expect(errorCode(await api(t, a).get(`/users/${b.id}`))).toBe('USER_NOT_FOUND');
      expect(errorCode(await api(t, b).get(`/users/by-username/${a.username}`))).toBe(
        'USER_NOT_FOUND',
      );
      // Edges and counters are gone.
      const edges = await t.platform.db
        .selectFrom('follows')
        .select('followerId')
        .where((eb) =>
          eb.or([eb('followerId', 'in', [a.id, b.id]), eb('followeeId', 'in', [a.id, b.id])]),
        )
        .execute();
      expect(edges).toEqual([]);
      const pa = await t.platform.db
        .selectFrom('profiles')
        .select(['followerCount', 'followingCount'])
        .where('userId', '=', a.id)
        .executeTakeFirstOrThrow();
      expect(pa).toEqual({ followerCount: 0, followingCount: 0 });
      // Following is impossible in either direction while blocked.
      expect(errorCode(await api(t, b).post(`/users/${a.id}/follow`))).toBe('USER_NOT_FOUND');
      expect(errorCode(await api(t, a).post(`/users/${b.id}/follow`))).toBe('USER_NOT_FOUND');

      const blocks = (await api(t, a).get('/me/blocks')).json();
      expect(blocks.items.map((x: { user: { id: string } }) => x.user.id)).toEqual([b.id]);
    });

    it('cancels pending follow requests and notifications between the pair', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const requester = await signupUser(t);
      await api(t, requester).post(`/users/${owner.id}/follow`);
      await api(t, owner).put(`/users/${requester.id}/block`);
      expect((await api(t, owner).get('/me/follow-requests')).json().items).toEqual([]);
      const n = await t.platform.db
        .selectFrom('notifications')
        .select('id')
        .where('recipientId', '=', owner.id)
        .execute();
      expect(n).toEqual([]);
    });

    it('removes blocked users from follower/following lists seen by the blocker', async () => {
      const star = await signupUser(t);
      const fan1 = await signupUser(t);
      const fan2 = await signupUser(t);
      const viewer = await signupUser(t);
      await api(t, fan1).post(`/users/${star.id}/follow`);
      await api(t, fan2).post(`/users/${star.id}/follow`);
      await api(t, viewer).put(`/users/${fan1.id}/block`);
      const ids = (await api(t, viewer).get(`/users/${star.id}/followers`))
        .json()
        .items.map((u: { id: string }) => u.id);
      expect(ids).toContain(fan2.id);
      expect(ids).not.toContain(fan1.id);
      // ...and the blocked user cannot see the blocker's presence either.
      const fan1View = (await api(t, fan1).get(`/users/${star.id}/followers`))
        .json()
        .items.map((u: { id: string }) => u.id);
      expect(fan1View).not.toContain(viewer.id);
    });

    it('unblocking restores visibility but not the old follow', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      await api(t, a).post(`/users/${b.id}/follow`);
      await api(t, a).put(`/users/${b.id}/block`);
      await api(t, a).del(`/users/${b.id}/block`);
      expect((await api(t, b).get(`/users/${a.id}`)).statusCode).toBe(200);
      expect((await api(t, a).get(`/users/${b.id}`)).json().viewer.relationship).toBe('NONE');
    });

    it('database trigger refuses follows across a block even if the API is bypassed', async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      await t.platform.db
        .insertInto('blocks')
        .values({ blockerId: a.id, blockedId: b.id })
        .execute();
      await expect(
        t.platform.db
          .insertInto('follows')
          .values({ followerId: b.id, followeeId: a.id })
          .execute(),
      ).rejects.toThrow(/relationship blocked/);
      await expect(
        t.platform.db
          .insertInto('followRequests')
          .values({ requesterId: a.id, targetId: b.id })
          .execute(),
      ).rejects.toThrow(/relationship blocked/);
    });

    it('cannot block yourself or a missing user', async () => {
      const a = await signupUser(t);
      expect(errorCode(await api(t, a).put(`/users/${a.id}/block`))).toBe(
        'SELF_ACTION_NOT_ALLOWED',
      );
      expect(
        errorCode(await api(t, a).put('/users/018f0000-0000-7000-8000-000000000000/block')),
      ).toBe('USER_NOT_FOUND');
    });
  });

  describe('anonymous access', () => {
    it('shows public profiles with a null viewer relation, and private headers without relation data', async () => {
      const pub = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const p1 = await api(t).get(`/users/${pub.id}`);
      expect(p1.statusCode).toBe(200);
      expect(p1.json().viewer).toBeNull();
      const p2 = (await api(t).get(`/users/by-username/${priv.username}`)).json();
      expect(p2.isPrivate).toBe(true);
      expect(p2.viewer).toBeNull();
    });

    it('a presented-but-bad token is an error even on optional-auth routes', async () => {
      const pub = await signupUser(t);
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/users/${pub.id}`,
        headers: { authorization: 'Bearer junk' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('counter integrity (property test)', () => {
    it('follower/following counters always equal the real edge counts after random churn', async () => {
      const users = await Promise.all(Array.from({ length: 6 }, () => signupUser(t)));
      // Deterministic pseudo-random operation stream.
      let seed = 42;
      const rnd = (n: number): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed % n;
      };
      for (let i = 0; i < 120; i++) {
        const a = users[rnd(users.length)] as TestUser;
        const b = users[rnd(users.length)] as TestUser;
        const op = rnd(5);
        if (a.id === b.id) continue;
        if (op <= 1) await api(t, a).post(`/users/${b.id}/follow`);
        else if (op === 2) await api(t, a).del(`/users/${b.id}/follow`);
        else if (op === 3) await api(t, a).put(`/users/${b.id}/block`);
        else await api(t, a).del(`/users/${b.id}/block`);
      }
      const rows = await t.platform.db
        .selectFrom('profiles as p')
        .select((eb) => [
          'p.userId',
          'p.followerCount',
          'p.followingCount',
          eb
            .selectFrom('follows as f')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('f.followeeId', '=', 'p.userId')
            .as('realFollowers'),
          eb
            .selectFrom('follows as f')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('f.followerId', '=', 'p.userId')
            .as('realFollowing'),
        ])
        .where(
          'p.userId',
          'in',
          users.map((u) => u.id),
        )
        .execute();
      for (const r of rows) {
        expect(r.followerCount).toBe(Number(r.realFollowers));
        expect(r.followingCount).toBe(Number(r.realFollowing));
      }
    });
  });
});
