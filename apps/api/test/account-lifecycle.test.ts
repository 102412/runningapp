import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  drainJobs,
  errorCode,
  PASSWORD,
  relogin,
  signupUser,
  type TestUser,
} from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { eastwardRoute } from './helpers/geo';
import { fetchSigned } from './helpers/media';
import { createPost, follow, readyImage, readyVideo } from './helpers/posts';

const DAY = 86_400;

describe('account lifecycle', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption = 'a post', extra: Record<string, unknown> = {}) =>
    createPost(t, user, { caption, visibility: 'PUBLIC', ...extra }) as Promise<{ id: string }>;

  /** Every (table, column) that references users(id) - the purge must leave none of them behind. */
  async function userReferences(userId: string): Promise<Array<{ table: string; rows: number }>> {
    const refs = await t.platform.pool.query<{ tbl: string; col: string }>(
      `select c.conrelid::regclass::text as tbl, a.attname as col
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and c.confrelid = 'users'::regclass`,
    );
    const out = [];
    for (const { tbl, col } of refs.rows) {
      const res = await t.platform.pool.query<{ n: string }>(
        `select count(*)::int as n from ${tbl} where "${col}" = $1`,
        [userId],
      );
      out.push({ table: `${tbl}.${col}`, rows: Number(res.rows[0]?.n ?? 0) });
    }
    return out;
  }

  async function richUser() {
    const victim = await signupUser(t, { username: 'leaving_user' });
    const friend = await signupUser(t);
    const fan = await signupUser(t);
    const stranger = await signupUser(t);

    // Content with real files: a video post, a photo avatar, an activity with a route.
    const video = await readyVideo(t, victim);
    const videoPost = await pub(victim, 'my video #gone', { mediaIds: [video] });
    const avatar = await readyImage(t, victim);
    await api(t, victim).put('/me/avatar', { mediaId: avatar });
    const activity = await api(t, victim).post('/activities', {
      sport: 'running',
      startedAt: '2026-03-01T08:00:00Z',
      elapsedTimeS: 1800,
      visibility: 'PUBLIC',
      route: { points: eastwardRoute(3) },
    });
    expect(activity.statusCode, activity.body).toBe(201);
    expect(
      (
        await api(t, victim).post('/me/privacy-zones', {
          label: 'home',
          lat: 44.0,
          lon: -123.0,
          radiusM: 200,
        })
      ).statusCode,
    ).toBe(201);
    await api(t, victim).put('/me/creator', { category: 'COACH' });

    // Social graph in both directions, a block each way, and a pending request.
    await follow(t, victim, friend);
    await follow(t, friend, victim);
    await follow(t, fan, victim);
    await api(t, victim).put(`/users/${stranger.id}/block`);

    // Engagement both ways.
    const friendPost = await pub(friend, 'friend post');
    await api(t, victim).put(`/posts/${friendPost.id}/reaction`, { type: 'FIRE' });
    await api(t, victim).put(`/posts/${friendPost.id}/bookmark`);
    const theirComment = (
      await api(t, victim).post(`/posts/${friendPost.id}/comments`, { body: 'nice one' })
    ).json<{ id: string }>();
    await api(t, friend).put(`/posts/${videoPost.id}/reaction`, { type: 'LIKE' });
    await api(t, friend).post(`/posts/${videoPost.id}/comments`, { body: 'great video' });
    await api(t, fan).post(`/posts/${videoPost.id}/shares`, { channel: 'COPY_LINK' });

    // Analytics, reports in both directions, search/feeds touched.
    await api(t, victim).post('/events', {
      events: [
        {
          eventId: '3b6f0c40-8d0e-4c1a-9a41-0a0b0c0d0e0f',
          type: 'IMPRESSION',
          postId: friendPost.id,
        },
      ],
    });
    await api(t, fan).get('/feed/home');
    await api(t, victim).get('/feed/home');
    await api(t, victim).post('/reports', {
      targetType: 'POST',
      targetId: friendPost.id,
      reason: 'SPAM',
    });
    await api(t, friend).post('/reports', {
      targetType: 'POST',
      targetId: videoPost.id,
      reason: 'SPAM',
    });
    await drainJobs(t);
    return { victim, friend, fan, stranger, video, videoPost, avatar, friendPost, theirComment };
  }

  describe('permanent deletion', () => {
    it('removes the account and everything hanging off it, queues all stored files, spares everyone else', async () => {
      const { victim, friend, fan, friendPost, videoPost } = await richUser();
      const mediaKeys = (
        await t.platform.db
          .selectFrom('mediaAssets')
          .select('storageKey')
          .where('ownerId', '=', victim.id)
          .execute()
      ).map((m) => m.storageKey);
      const variantKeys = (
        await t.platform.db
          .selectFrom('mediaVariants as v')
          .innerJoin('mediaAssets as m', 'm.id', 'v.mediaId')
          .select('v.storageKey')
          .where('m.ownerId', '=', victim.id)
          .execute()
      ).map((v) => v.storageKey);
      expect(mediaKeys.length).toBeGreaterThanOrEqual(2);
      expect(variantKeys.length).toBeGreaterThan(2);
      const someVariant = variantKeys[0] as string;
      expect(await t.services.storage.head(someVariant)).not.toBeNull();

      const requested = await api(t, victim).post('/me/account/deletion', { password: PASSWORD });
      expect(requested.statusCode, requested.body).toBeLessThan(300);

      // Not due yet: nothing happens.
      await t.services.accountPurger.handlePurgeDue();
      expect(
        await t.platform.db
          .selectFrom('users')
          .select('id')
          .where('id', '=', victim.id)
          .executeTakeFirst(),
      ).toBeDefined();

      t.clock.advanceSeconds((t.config.ACCOUNT_DELETION_GRACE_DAYS + 1) * DAY);
      // purge() throws on failure (handlePurgeDue logs and moves on), so assert on it directly.
      expect(await t.services.accountPurger.purge(victim.id)).toBe(true);

      expect(
        await t.platform.db
          .selectFrom('users')
          .select('id')
          .where('id', '=', victim.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      const leftovers = (await userReferences(victim.id)).filter((r) => r.rows > 0);
      expect(leftovers).toEqual([]);

      // Their stored files are queued for deletion in the same transaction, then really removed.
      await drainJobs(t);
      for (const key of [...mediaKeys, ...variantKeys]) {
        expect(await t.services.storage.head(key), key).toBeNull();
      }

      // Everyone else is intact; counters moved with the data. (The clock jumped a month: sign in again.)
      const friend2 = await relogin(t, friend);
      const friendFresh = (await api(t, friend2).get(`/posts/${friendPost.id}`)).json<{
        counts: { reactions: number; comments: number };
      }>();
      expect(friendFresh.counts).toEqual(expect.objectContaining({ reactions: 0, comments: 0 }));
      expect((await api(t, friend2).get(`/posts/${videoPost.id}`)).statusCode).toBe(404);
      const fanProfile = await t.platform.db
        .selectFrom('profiles')
        .select('followingCount')
        .where('userId', '=', fan.id)
        .executeTakeFirstOrThrow();
      expect(fanProfile.followingCount).toBe(0);
      const friendProfile = await t.platform.db
        .selectFrom('profiles')
        .select(['followerCount', 'followingCount'])
        .where('userId', '=', friend.id)
        .executeTakeFirstOrThrow();
      expect(friendProfile).toEqual({ followerCount: 0, followingCount: 0 });

      // Reports other people filed about their content went with it; the one they filed stays, detached.
      const reports = await t.platform.db
        .selectFrom('reports')
        .select(['reporterId', 'targetPostId'])
        .execute();
      expect(reports).toEqual([{ reporterId: null, targetPostId: friendPost.id }]);
    });

    it('the scheduled job purges every due account and only those', async () => {
      const [a, b, keep] = [await signupUser(t), await signupUser(t), await signupUser(t)];
      await api(t, a).post('/me/account/deletion', { password: PASSWORD });
      await api(t, b).post('/me/account/deletion', { password: PASSWORD });
      t.clock.advanceSeconds((t.config.ACCOUNT_DELETION_GRACE_DAYS + 1) * DAY);
      await t.services.accountPurger.handlePurgeDue();
      const remaining = await t.platform.db.selectFrom('users').select('id').execute();
      expect(remaining.map((u) => u.id)).toEqual([keep.id]);
    });

    it('does not purge an account whose deletion was cancelled', async () => {
      const user = await signupUser(t);
      await api(t, user).post('/me/account/deletion', { password: PASSWORD });
      // The requesting session stays valid in restricted mode so the user can change their mind.
      expect((await api(t, user).del('/me/account/deletion')).statusCode).toBe(204);
      t.clock.advanceSeconds((t.config.ACCOUNT_DELETION_GRACE_DAYS + 5) * DAY);
      await t.services.accountPurger.handlePurgeDue();
      expect(
        await t.platform.db
          .selectFrom('users')
          .select('id')
          .where('id', '=', user.id)
          .executeTakeFirst(),
      ).toBeDefined();
    });

    it('keeps the moderation audit trail after the moderated account is purged', async () => {
      const staff = await signupUser(t);
      await t.platform.db
        .updateTable('users')
        .set({ role: 'MODERATOR' })
        .where('id', '=', staff.id)
        .execute();
      const user = await signupUser(t);
      const post = await pub(user);
      await api(t, staff).post('/admin/moderation/actions', {
        action: 'HIDE_CONTENT',
        targetType: 'POST',
        targetId: post.id,
        note: 'spam',
      });
      await api(t, user).post('/me/account/deletion', { password: PASSWORD });
      t.clock.advanceSeconds((t.config.ACCOUNT_DELETION_GRACE_DAYS + 1) * DAY);
      await t.services.accountPurger.handlePurgeDue();
      const audit = await t.platform.db
        .selectFrom('moderationActions')
        .select(['targetPostId', 'targetUserId'])
        .execute();
      expect(audit).toEqual([{ targetPostId: post.id, targetUserId: user.id }]);
    });
  });

  describe('data export', () => {
    const request = (user: TestUser, password = PASSWORD) =>
      api(t, user).post('/me/exports', { password });

    async function download(user: TestUser, id: string) {
      const info = (await api(t, user).get(`/me/exports/${id}`)).json<{
        status: string;
        downloadUrl: string | null;
      }>();
      expect(info.status).toBe('READY');
      const res = await fetchSigned(t, info.downloadUrl as string);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toContain('attachment');
      return JSON.parse(res.body) as Record<string, unknown> & {
        account: { email: string };
        activities: Array<{ route: { polyline: string } | null }>;
        posts: Array<{ caption: string; topics: string[] }>;
        comments: Array<{ body: string }>;
        behaviouralEvents: unknown[];
        following: Array<{ username: string }>;
        followers: Array<{ username: string }>;
        blockedUsers: Array<{ username: string }>;
        devices: Array<Record<string, unknown>>;
        privacyZones: unknown[];
      };
    }

    it('needs the password, builds in the background, and returns a complete, secret-free file', async () => {
      const { victim, friend, stranger } = await richUser();
      expect((await api(t).post('/me/exports', { password: 'x' })).statusCode).toBe(401);
      expect(errorCode(await request(victim, 'wrong-password-1'))).toBe('PASSWORD_INCORRECT');
      expect(errorCode(await api(t, victim).post('/me/exports', {}))).toBe('VALIDATION_FAILED');

      const accepted = await request(victim);
      expect(accepted.statusCode).toBe(202);
      const created = accepted.json<{ id: string; status: string; downloadUrl: string | null }>();
      expect([created.status, created.downloadUrl]).toEqual(['PENDING', null]);
      // Asking again while it builds hands back the same one.
      expect((await request(victim)).json<{ id: string }>().id).toBe(created.id);

      await drainJobs(t);
      const file = await download(victim, created.id);
      expect(file.account.email).toBe(victim.email);
      expect(file.activities).toHaveLength(1);
      expect(file.activities[0]?.route?.polyline.length).toBeGreaterThan(10); // full, unfiltered route
      expect(file.posts.map((p) => p.caption)).toContain('my video #gone');
      expect(file.posts.find((p) => p.caption === 'my video #gone')?.topics).toContain('gone');
      expect(file.comments.map((c) => c.body)).toEqual(['nice one']); // only their own comments
      expect(file.behaviouralEvents.length).toBeGreaterThan(0);
      expect(file.following.map((f) => f.username)).toHaveLength(1);
      expect(file.followers).toHaveLength(2);
      expect(file.blockedUsers.map((b) => b.username)).toEqual([
        (
          await t.platform.db
            .selectFrom('profiles')
            .select('username')
            .where('userId', '=', stranger.id)
            .executeTakeFirstOrThrow()
        ).username,
      ]);
      expect(file.privacyZones).toHaveLength(1);
      expect(friend.id).toBeDefined();

      // Nothing secret, and nothing about other people's content.
      const text = JSON.stringify(file);
      const user = await t.platform.db
        .selectFrom('users')
        .select('passwordHash')
        .where('id', '=', victim.id)
        .executeTakeFirstOrThrow();
      expect(text).not.toContain(user.passwordHash as string);
      expect(text).not.toContain(victim.refreshToken);
      expect(text).not.toContain('friend post');
      for (const d of file.devices) expect(Object.keys(d)).not.toContain('pushToken');
    });

    it('pages through large histories (more than one page of events)', async () => {
      const user = await signupUser(t);
      const author = await signupUser(t);
      const post = await pub(author);
      await t.platform.pool.query(
        `insert into feed_events (event_id, user_id, event_type, origin, post_id)
         select gen_random_uuid(), $1, 'IMPRESSION', 'CLIENT', $2 from generate_series(1, 1234)`,
        [user.id, post.id],
      );
      const id = (await request(user)).json<{ id: string }>().id;
      await drainJobs(t);
      expect((await download(user, id)).behaviouralEvents).toHaveLength(1234);
    });

    it("is limited to one a day, lists history, hides other people's exports, and expires after a week", async () => {
      const user = await signupUser(t);
      const other = await signupUser(t);
      const first = (await request(user)).json<{ id: string }>();
      await drainJobs(t);
      const second = await request(user);
      expect(second.statusCode).toBe(429);
      expect(errorCode(second)).toBe('RATE_LIMITED');

      expect((await api(t, other).get(`/me/exports/${first.id}`)).statusCode).toBe(404);
      expect((await api(t, other).get('/me/exports')).json<{ items: unknown[] }>().items).toEqual(
        [],
      );
      const listed = (await api(t, user).get('/me/exports')).json<{
        items: Array<{ id: string; downloadUrl: string | null }>;
      }>();
      expect(listed.items.map((e) => e.id)).toEqual([first.id]);
      expect(listed.items[0]?.downloadUrl).not.toBeNull();

      // After a day a new one is allowed again.
      t.clock.advanceSeconds(DAY + 60);
      const again = await request(await relogin(t, user));
      expect(again.statusCode).toBe(202);
      await drainJobs(t);

      // A week on, the files are deleted and links stop working.
      t.clock.advanceSeconds(8 * DAY);
      await t.services.dataExports.handleExpire();
      const rows = await t.platform.db
        .selectFrom('dataExports')
        .select(['status', 'storageKey'])
        .execute();
      expect(rows.every((r) => r.status === 'EXPIRED' && r.storageKey === null)).toBe(true);
      const fresh = await relogin(t, user);
      const info = (await api(t, fresh).get(`/me/exports/${first.id}`)).json<{
        status: string;
        downloadUrl: string | null;
      }>();
      expect([info.status, info.downloadUrl]).toEqual(['EXPIRED', null]);
    });

    it('records a failure without leaking details, cleans up, and allows an immediate retry', async () => {
      const user = await signupUser(t);
      const upload = vi
        .spyOn(t.services.storage, 'uploadFile')
        .mockRejectedValueOnce(new Error('disk on fire /secret/path'));

      const id = (await request(user)).json<{ id: string }>().id;
      await drainJobs(t);
      const failed = (await api(t, user).get(`/me/exports/${id}`)).json<{
        status: string;
        downloadUrl: string | null;
      }>();
      expect([failed.status, failed.downloadUrl]).toEqual(['FAILED', null]);
      expect(JSON.stringify(failed)).not.toContain('disk on fire');
      expect(upload).toHaveBeenCalledTimes(1);

      // Failures do not count against the daily limit.
      const retry = await request(user);
      expect(retry.statusCode).toBe(202);
      await drainJobs(t);
      expect((await download(user, retry.json<{ id: string }>().id)).account.email).toBe(
        user.email,
      );
    });
  });
});
