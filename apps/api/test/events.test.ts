import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, errorCode, relogin, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

type EventInput = Record<string, unknown> & { eventId: string; type: string };
const ev = (type: string, extra: Record<string, unknown> = {}): EventInput => ({
  eventId: randomUUID(),
  type,
  ...extra,
});

interface FeedPage {
  requestId: string;
  items: Array<{ post: { id: string; author: { id: string } }; reason: string }>;
  nextCursor: string | null;
}

describe('events, analytics jobs and learned ranking', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption = 'a public post', extra: Record<string, unknown> = {}) =>
    createPost(t, user, { caption, visibility: 'PUBLIC', ...extra }) as Promise<{ id: string }>;
  const send = (user: TestUser, events: EventInput[]) => api(t, user).post('/events', { events });
  const stored = (userId: string) =>
    t.platform.db.selectFrom('feedEvents').selectAll().where('userId', '=', userId).execute();
  const feed = async (user: TestUser, surface: string, query = '') =>
    (await api(t, user).get(`/feed/${surface}${query}`)).json<FeedPage>();
  /** Lets just-written events count as "settled" for the id-ordered analytics jobs. */
  const settle = () => t.clock.advanceSeconds(120);

  describe('POST /events', () => {
    it('stores a batch, derives the activity, and is idempotent per eventId', async () => {
      const author = await signupUser(t);
      const viewer = await signupUser(t);
      const activity = await api(t, author).post('/activities', {
        sport: 'running',
        startedAt: '2026-03-01T08:00:00Z',
        elapsedTimeS: 1800,
        visibility: 'PUBLIC',
      });
      const activityId = activity.json<{ id: string }>().id;
      const post = await t.platform.db
        .selectFrom('posts')
        .select('id')
        .where('activityId', '=', activityId)
        .executeTakeFirstOrThrow();

      const page = await feed(viewer, 'explore');
      const batch = [
        ev('IMPRESSION', {
          postId: post.id,
          surface: 'EXPLORE',
          feedRequestId: page.requestId,
          position: 0,
        }),
        ev('WATCH_TIME', { postId: post.id, valueMs: 4200 }),
        ev('ACTIVITY_OPEN', { postId: post.id }),
        ev('TOPIC_INTERACTION', { topic: 'Marathon' }),
        ev('PROFILE_OPEN', { subjectUserId: author.id }),
      ];
      const first = await send(viewer, batch);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ accepted: 5, duplicates: 0, rejected: [] });

      const rows = await stored(viewer.id);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.origin === 'CLIENT')).toBe(true);
      const impression = rows.find((r) => r.eventType === 'IMPRESSION');
      expect(impression).toMatchObject({
        postId: post.id,
        activityId,
        surface: 'EXPLORE',
        feedRequestId: page.requestId,
        position: 0,
      });
      expect(rows.find((r) => r.eventType === 'TOPIC_INTERACTION')?.topic).toBe('marathon');
      expect(rows.find((r) => r.eventType === 'WATCH_TIME')?.valueMs).toBe(4200);

      // The whole batch again (a network retry), plus a repeat inside one request.
      const again = await send(viewer, [
        ...batch,
        ev('SKIP', { postId: post.id, eventId: batch[0]?.eventId }),
      ]);
      expect(again.json()).toEqual({ accepted: 0, duplicates: 6, rejected: [] });
      expect(await stored(viewer.id)).toHaveLength(5);
    });

    it('rejects events about content the user cannot see, without storing them', async () => {
      const viewer = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const blocker = await signupUser(t);
      const open = await signupUser(t);
      const privatePost = await pub(priv);
      const blockerPost = await pub(blocker);
      const openPost = await pub(open);
      await api(t, blocker).put(`/users/${viewer.id}/block`);

      const res = await send(viewer, [
        ev('IMPRESSION', { postId: privatePost.id }),
        ev('IMPRESSION', { postId: blockerPost.id }),
        ev('IMPRESSION', { postId: randomUUID() }),
        ev('PROFILE_OPEN', { subjectUserId: blocker.id }),
        ev('IMPRESSION', { postId: openPost.id }),
      ]);
      const body = res.json<{
        accepted: number;
        rejected: Array<{ eventId: string; code: string }>;
      }>();
      expect(body.accepted).toBe(1);
      expect(body.rejected.map((r) => r.code)).toEqual([
        'POST_NOT_FOUND',
        'POST_NOT_FOUND',
        'POST_NOT_FOUND',
        'USER_NOT_FOUND',
      ]);
      expect((await stored(viewer.id)).map((r) => r.postId)).toEqual([openPost.id]);
    });

    it('validates shape strictly', async () => {
      const u = await signupUser(t);
      const post = await pub(u);
      const bad = async (events: unknown[]) =>
        (await api(t, u).post('/events', { events })).statusCode;
      expect(await bad([ev('IMPRESSION')])).toBe(422); // postId required
      expect(await bad([ev('WATCH_TIME', { postId: post.id })])).toBe(422); // valueMs required
      expect(await bad([ev('PROFILE_OPEN')])).toBe(422);
      expect(await bad([ev('TOPIC_INTERACTION')])).toBe(422);
      expect(await bad([ev('LIKE', { postId: post.id })])).toBe(422); // server-recorded type
      expect(await bad([ev('IMPRESSION', { postId: post.id, valueMs: -1 })])).toBe(422);
      expect(await bad([ev('IMPRESSION', { postId: post.id, hacker: true })])).toBe(422);
      expect(await bad([{ type: 'IMPRESSION', postId: post.id }])).toBe(422); // no eventId
      expect(await bad([ev('IMPRESSION', { postId: 'nope', eventId: 'nope' })])).toBe(422);
      expect(await bad([])).toBe(422);
      expect(
        await bad(Array.from({ length: 101 }, () => ev('IMPRESSION', { postId: post.id }))),
      ).toBe(422);
      expect(
        (
          await send(
            u,
            Array.from({ length: 100 }, () => ev('IMPRESSION', { postId: post.id })),
          )
        ).statusCode,
      ).toBe(200);
      expect(errorCode(await api(t, u).post('/events', { events: [ev('IMPRESSION')] }))).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('does not trust attribution or timestamps from the client', async () => {
      const author = await signupUser(t);
      const me = await signupUser(t);
      const other = await signupUser(t);
      const post = await pub(author);
      const mine = await feed(me, 'explore');
      const theirs = await feed(other, 'explore');

      const sane = new Date(t.clock.now().getTime() - 60_000).toISOString();
      const ancient = new Date(t.clock.now().getTime() - 90 * 86_400_000).toISOString();
      const future = new Date(t.clock.now().getTime() + 86_400_000).toISOString();
      const events = [
        ev('IMPRESSION', { postId: post.id, feedRequestId: mine.requestId, clientTs: sane }),
        ev('IMPRESSION', { postId: post.id, feedRequestId: theirs.requestId, clientTs: ancient }),
        ev('IMPRESSION', { postId: post.id, feedRequestId: randomUUID(), clientTs: future }),
      ];
      await send(me, events);
      const rows = new Map((await stored(me.id)).map((r) => [r.eventId, r]));
      expect(rows.get(events[0]?.eventId as string)).toMatchObject({
        feedRequestId: mine.requestId,
      });
      expect(rows.get(events[0]?.eventId as string)?.clientTs).not.toBeNull();
      // Someone else's (or an unknown) request id is dropped, not stored and not an error.
      expect(rows.get(events[1]?.eventId as string)?.feedRequestId).toBeNull();
      expect(rows.get(events[2]?.eventId as string)?.feedRequestId).toBeNull();
      // Implausible device timestamps are ignored.
      expect(rows.get(events[1]?.eventId as string)?.clientTs).toBeNull();
      expect(rows.get(events[2]?.eventId as string)?.clientTs).toBeNull();
    });

    it('discards behavioural events when personalization is off (except "not interested")', async () => {
      const author = await signupUser(t);
      const me = await signupUser(t);
      const post = await pub(author);
      await api(t, me).patch('/me/settings', { personalizationEnabled: false });

      const res = await send(me, [
        ev('IMPRESSION', { postId: post.id }),
        ev('WATCH_TIME', { postId: post.id, valueMs: 1000 }),
        ev('NOT_INTERESTED', { postId: post.id }),
      ]);
      expect(res.json()).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
      expect((await stored(me.id)).map((r) => r.eventType)).toEqual(['NOT_INTERESTED']);

      await api(t, me).patch('/me/settings', { personalizationEnabled: true });
      await send(me, [ev('IMPRESSION', { postId: post.id })]);
      expect((await stored(me.id)).map((r) => r.eventType).sort()).toEqual([
        'IMPRESSION',
        'NOT_INTERESTED',
      ]);
    });

    it('"not interested" removes the post from every feed, immediately', async () => {
      const me = await signupUser(t);
      const friend = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(t, me, friend);
      const friendPost = await pub(friend);
      const strangerPost = await pub(stranger);
      const keep = await pub(stranger, 'second');

      const before = await feed(me, 'home');
      expect(before.items.map((i) => i.post.id)).toEqual(
        expect.arrayContaining([friendPost.id, strangerPost.id]),
      );
      // Snapshot taken before the signal: the hide still applies when its pages are served.
      const frozen = await feed(me, 'explore', '?limit=1');

      await send(me, [
        ev('NOT_INTERESTED', { postId: friendPost.id }),
        ev('NOT_INTERESTED', { postId: strangerPost.id }),
      ]);
      for (const surface of ['home', 'explore', 'following']) {
        const ids = (await feed(me, surface)).items.map((i) => i.post.id);
        expect(ids, surface).not.toContain(friendPost.id);
        expect(ids, surface).not.toContain(strangerPost.id);
      }
      expect((await feed(me, 'explore')).items.map((i) => i.post.id)).toEqual([keep.id]);
      const next = await api(t, me).get(`/feed/explore?cursor=${frozen.nextCursor}`);
      expect(next.statusCode).toBe(200);
      expect(next.json<FeedPage>().items.map((i) => i.post.id)).not.toContain(strangerPost.id);
    });
  });

  describe('server-recorded events', () => {
    it('records likes, comments, shares, bookmarks and follows with feed attribution', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const post = await pub(author);
      const page = await feed(fan, 'explore');
      const context = { feedRequestId: page.requestId, surface: 'EXPLORE', position: 3 };

      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE', context });
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'FIRE', context }); // change, not a new like
      await api(t, fan).del(`/posts/${post.id}/reaction`);
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, fan).put(`/posts/${post.id}/bookmark`);
      await api(t, fan).del(`/posts/${post.id}/bookmark`);
      await api(t, fan).post(`/posts/${post.id}/shares`, { channel: 'COPY_LINK', context });
      await api(t, fan).post(`/posts/${post.id}/comments`, { body: 'nice!', context });
      await api(t, fan).post(`/users/${author.id}/follow`);
      await api(t, fan).del(`/users/${author.id}/follow`);

      const rows = await stored(fan.id);
      expect(rows.map((r) => r.eventType).sort()).toEqual(
        [
          'LIKE',
          'UNLIKE',
          'LIKE',
          'BOOKMARK',
          'UNBOOKMARK',
          'SHARE',
          'COMMENT',
          'FOLLOW',
          'UNFOLLOW',
        ].sort(),
      );
      expect(rows.every((r) => r.origin === 'SERVER')).toBe(true);
      const firstLike = rows.find((r) => r.eventType === 'LIKE' && r.position === 3);
      expect(firstLike).toMatchObject({
        postId: post.id,
        surface: 'EXPLORE',
        feedRequestId: page.requestId,
      });
      expect(rows.find((r) => r.eventType === 'FOLLOW')?.subjectUserId).toBe(author.id);
    });

    it('records nothing for failed or repeated actions, and nothing when personalization is off', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const blocked = await signupUser(t);
      const post = await pub(author);
      const hidden = await pub(blocked);
      await api(t, blocked).put(`/users/${fan.id}/block`);

      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' }); // repeat
      await api(t, fan).del(`/posts/${post.id}/reaction`);
      await api(t, fan).del(`/posts/${post.id}/reaction`); // repeat
      expect(
        (await api(t, fan).put(`/posts/${hidden.id}/reaction`, { type: 'LIKE' })).statusCode,
      ).toBe(404);
      expect((await stored(fan.id)).map((r) => r.eventType)).toEqual(['LIKE', 'UNLIKE']);

      await api(t, fan).patch('/me/settings', { personalizationEnabled: false });
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, fan).post(`/users/${author.id}/follow`);
      expect(await stored(fan.id)).toHaveLength(2);
    });

    it('records a FOLLOW for the requester when a private account approves them', async () => {
      const priv = await signupUser(t, { isPrivate: true });
      const requester = await signupUser(t);
      expect((await api(t, requester).post(`/users/${priv.id}/follow`)).json()).toMatchObject({
        relationship: 'REQUESTED',
      });
      expect(await stored(requester.id)).toHaveLength(0);
      const requests = (await api(t, priv).get('/me/follow-requests')).json<{
        items: Array<{ id: string }>;
      }>();
      await api(t, priv).post(`/me/follow-requests/${requests.items[0]?.id}/accept`);
      expect((await stored(requester.id)).map((r) => r.eventType)).toEqual(['FOLLOW']);
    });
  });

  describe('post_stats rollup', () => {
    it('folds events in exactly once, ignores the author, counts a user once per batch, caps watch time', async () => {
      const author = await signupUser(t);
      const u1 = await signupUser(t);
      const u2 = await signupUser(t);
      const u3 = await signupUser(t);
      const post = await pub(author);
      const p = { postId: post.id };

      await send(u1, [
        ev('IMPRESSION', p),
        ev('IMPRESSION', p),
        ev('IMPRESSION', p),
        ev('VIDEO_START', p),
        ev('VIDEO_COMPLETE', p),
        ev('WATCH_TIME', { ...p, valueMs: 700_000 }),
      ]);
      await send(u2, [
        ev('IMPRESSION', p),
        ev('SKIP', p),
        ev('WATCH_TIME', { ...p, valueMs: 5_000 }),
      ]);
      await send(u3, [ev('NOT_INTERESTED', p)]);
      await send(author, [ev('IMPRESSION', p), ev('VIDEO_COMPLETE', p)]);

      const analytics = t.services.feedAnalytics;
      // Too fresh: nothing is processed inside the settle window.
      expect(await analytics.rollupBatch(60)).toBe(0);
      settle();
      expect(await analytics.rollupBatch(60)).toBeGreaterThan(0);

      const read = () =>
        t.platform.db
          .selectFrom('postStats')
          .selectAll()
          .where('postId', '=', post.id)
          .executeTakeFirstOrThrow();
      expect(await read()).toMatchObject({
        impressions: 2,
        videoStarts: 1,
        videoCompletes: 1,
        skips: 1,
        notInterested: 1,
        watchTimeMs: 605_000, // 600_000 (capped) + 5_000
      });

      // Re-running is a no-op: the watermark moved with the counters.
      expect(await analytics.rollupBatch(60)).toBe(0);
      expect((await read()).impressions).toBe(2);

      // New events accumulate.
      await send(u3, [ev('IMPRESSION', p)]);
      settle();
      await analytics.handleRollup({ settleSeconds: 60 });
      expect(await read()).toMatchObject({ impressions: 3, notInterested: 1 });
    });

    it('drives the ranking quality signal', async () => {
      const me = await signupUser(t);
      const good = await signupUser(t);
      const bad = await signupUser(t);
      const goodPost = await pub(good);
      t.clock.advanceSeconds(1);
      const badPost = await pub(bad); // newer, so it leads on recency alone
      expect((await feed(me, 'explore')).items.map((i) => i.post.id)).toEqual([
        badPost.id,
        goodPost.id,
      ]);

      const crowd = await Promise.all(Array.from({ length: 12 }, () => signupUser(t)));
      for (const u of crowd) {
        await send(u, [
          ev('IMPRESSION', { postId: goodPost.id }),
          ev('IMPRESSION', { postId: badPost.id }),
          ev('NOT_INTERESTED', { postId: badPost.id }),
        ]);
        await api(t, u).put(`/posts/${goodPost.id}/reaction`, { type: 'LIKE' });
      }
      settle();
      await t.services.feedAnalytics.handleRollup({ settleSeconds: 60 });
      const me2 = await signupUser(t);
      expect((await feed(me2, 'explore')).items.map((i) => i.post.id)[0]).toBe(goodPost.id);
    });
  });

  describe('affinities', () => {
    const activityPost = async (user: TestUser, sport: string) => {
      const res = await api(t, user).post('/activities', {
        sport,
        startedAt: '2026-03-01T08:00:00Z',
        elapsedTimeS: 1800,
        visibility: 'PUBLIC',
      });
      expect(res.statusCode, res.body).toBe(201);
      const row = await t.platform.db
        .selectFrom('posts')
        .select('id')
        .where('authorId', '=', user.id)
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      return row.id;
    };

    it('learns taste from behaviour and applies it on the next refresh', async () => {
      const me = await signupUser(t);
      const rider = await signupUser(t);
      const runner = await signupUser(t);
      const ridePost = await activityPost(rider, 'cycling');
      const ridePost2 = await activityPost(rider, 'cycling');
      t.clock.advanceSeconds(60);
      const runPost = await activityPost(runner, 'running'); // newest: leads on recency alone

      expect((await feed(me, 'explore')).items[0]?.post.id).toBe(runPost);

      await api(t, me).put(`/posts/${ridePost}/reaction`, { type: 'LIKE' });
      await api(t, me).post(`/posts/${ridePost}/shares`, { channel: 'COPY_LINK' });
      await send(me, [ev('WATCH_TIME', { postId: ridePost, valueMs: 30_000 })]);
      settle();
      await t.services.feedAnalytics.handleAffinities({ settleSeconds: 60 });

      const learned = await t.platform.db
        .selectFrom('userAffinities')
        .select(['subjectType', 'subjectKey', 'score'])
        .where('userId', '=', me.id)
        .execute();
      const score = (type: string, key: string) =>
        learned.find((a) => a.subjectType === type && a.subjectKey === key)?.score ?? 0;
      expect(score('CREATOR', rider.id)).toBeGreaterThan(0.4);
      expect(score('SPORT', 'cycling')).toBeGreaterThan(0.4);
      expect(score('SPORT', 'running')).toBe(0);

      // The unseen post by the creator I engaged with now scores above the newer, unrelated one
      // (the list order also spaces out a single author, so compare the logged scores).
      const refreshed = await feed(me, 'explore');
      const logged = await t.platform.db
        .selectFrom('recommendationEvents')
        .select(['postId', 'score'])
        .where('feedRequestId', '=', refreshed.requestId)
        .execute();
      const scoreOf = (id: string) => logged.find((l) => l.postId === id)?.score ?? 0;
      expect(scoreOf(ridePost2)).toBeGreaterThan(scoreOf(runPost));
      expect(refreshed.items.find((i) => i.post.id === ridePost2)?.reason).toBe('CREATOR_AFFINITY');
    });

    it('two "not interested" strikes stop a creator being recommended; a follow still shows them', async () => {
      const me = await signupUser(t);
      const spammer = await signupUser(t);
      const fine = await signupUser(t);
      const [a, b, c] = [await pub(spammer, 'a'), await pub(spammer, 'b'), await pub(spammer, 'c')];
      const ok = await pub(fine, 'fine');
      expect((await feed(me, 'explore')).items).toHaveLength(3); // at most 2 per author in explore

      await send(me, [ev('NOT_INTERESTED', { postId: a.id })]);
      settle();
      await t.services.feedAnalytics.handleAffinities({ settleSeconds: 60 });
      // One strike hides that post, but the creator is still recommended.
      expect((await feed(me, 'explore')).items.map((i) => i.post.id).sort()).toEqual(
        [b.id, c.id, ok.id].sort(),
      );

      await send(me, [ev('NOT_INTERESTED', { postId: b.id })]);
      settle();
      await t.services.feedAnalytics.handleAffinities({ settleSeconds: 60 });
      expect((await feed(me, 'explore')).items.map((i) => i.post.id)).toEqual([ok.id]);

      // Following is an explicit choice and overrides the learned dislike.
      await follow(t, me, spammer);
      expect((await feed(me, 'home')).items.map((i) => i.post.id)).toContain(c.id);
    });

    it('sinks posts you were already shown, unless personalization is off', async () => {
      let me = await signupUser(t);
      const older = await signupUser(t);
      const newer = await signupUser(t);
      await follow(t, me, older);
      await follow(t, me, newer);
      const olderPost = await pub(older);
      t.clock.advanceSeconds(3600);
      me = await relogin(t, me);
      const newerAuthor = await relogin(t, newer);
      const newerPost = await pub(newerAuthor);
      const order = async () => (await feed(me, 'home')).items.map((i) => i.post.id);

      expect(await order()).toEqual([newerPost.id, olderPost.id]);
      await send(me, [ev('IMPRESSION', { postId: newerPost.id })]);
      await send(me, [ev('IMPRESSION', { postId: newerPost.id })]);
      await send(me, [ev('IMPRESSION', { postId: newerPost.id })]);
      expect(await order()).toEqual([olderPost.id, newerPost.id]);

      await api(t, me).patch('/me/settings', { personalizationEnabled: false });
      expect(await order()).toEqual([newerPost.id, olderPost.id]);
    });

    it('deletes learned taste when personalization is switched off', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t);
      const post = await pub(author);
      await api(t, me).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, me).post(`/posts/${post.id}/shares`, { channel: 'COPY_LINK' });
      settle();
      await t.services.feedAnalytics.handleAffinities({ settleSeconds: 60 });
      const count = () =>
        t.platform.db
          .selectFrom('userAffinities')
          .select('userId')
          .where('userId', '=', me.id)
          .execute();
      expect((await count()).length).toBeGreaterThan(0);

      await api(t, me).patch('/me/settings', { personalizationEnabled: false });
      await t.services.feedAnalytics.refreshUser(me.id);
      expect(await count()).toHaveLength(0);
    });

    it('ignores interactions with your own posts', async () => {
      const me = await signupUser(t);
      const post = await pub(me);
      await api(t, me).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await t.services.feedAnalytics.refreshUser(me.id);
      expect(
        await t.platform.db
          .selectFrom('userAffinities')
          .select('userId')
          .where('userId', '=', me.id)
          .execute(),
      ).toHaveLength(0);
    });
  });

  describe('retention', () => {
    it('purges expired snapshots and events past the retention window, keeping the rest', async () => {
      const me = await signupUser(t);
      const author = await signupUser(t);
      const post = await pub(author);
      await feed(me, 'explore'); // creates a snapshot + a request
      await send(me, [ev('IMPRESSION', { postId: post.id })]);

      const old = new Date(t.clock.now().getTime() - 400 * 86_400_000);
      await t.platform.db
        .insertInto('feedEvents')
        .values({
          eventId: randomUUID(),
          userId: me.id,
          eventType: 'IMPRESSION',
          origin: 'CLIENT',
          postId: post.id,
          createdAt: old,
        })
        .execute();
      await t.platform.db
        .insertInto('feedRequests')
        .values({
          userId: me.id,
          surface: 'HOME',
          algorithmVersion: 'x',
          itemCount: 0,
          createdAt: old,
        })
        .execute();

      const counts = async () => ({
        events: (await t.platform.db.selectFrom('feedEvents').select('id').execute()).length,
        requests: (await t.platform.db.selectFrom('feedRequests').select('id').execute()).length,
        snapshots: (await t.platform.db.selectFrom('feedSnapshots').select('id').execute()).length,
      });
      expect(await counts()).toEqual({ events: 2, requests: 2, snapshots: 1 });

      await t.services.feedAnalytics.handlePurge();
      expect(await counts()).toEqual({ events: 1, requests: 1, snapshots: 1 });

      t.clock.advanceSeconds((t.config.FEED_SNAPSHOT_TTL_MINUTES + 1) * 60);
      await t.services.feedAnalytics.handlePurge();
      expect((await counts()).snapshots).toBe(0);
    });
  });
});
