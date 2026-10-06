import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage, PushProvider, PushResult } from '../src/platform/ports/push';
import { renderPush } from '../src/modules/notifications/service';
import { drainJobs, api, errorCode, relogin, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow, readyImage } from './helpers/posts';

class CapturePush implements PushProvider {
  sent: PushMessage[] = [];
  invalidTokens = new Set<string>();
  async send(message: PushMessage): Promise<PushResult> {
    if (this.invalidTokens.has(message.token))
      return { ok: false, invalidToken: true, error: 'unregistered' };
    this.sent.push(message);
    return { ok: true };
  }
}

describe('notifications', () => {
  const push = new CapturePush();
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ overrides: { push } });
  });
  afterAll(async () => {
    await t.close();
  });

  const list = async (u: TestUser, qs = '') => (await api(t, u).get(`/notifications${qs}`)).json();
  const types = async (u: TestUser) => (await list(u)).items.map((n: { type: string }) => n.type);

  it('lists notifications with the actor, post preview and comment excerpt ready to render', async () => {
    const author = await signupUser(t);
    const fan = await signupUser(t);
    const img = await readyImage(t, author);
    const post = await createPost(t, author, {
      caption: 'Sunrise intervals at the track, felt incredible today',
      mediaIds: [img],
    });
    await api(t, fan).post(`/users/${author.id}/follow`);
    await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'FIRE' });
    await api(t, fan).post(`/posts/${post.id}/comments`, { body: 'Beast mode 🔥' });

    const res = await list(author);
    expect(res.items.map((n: { type: string }) => n.type).sort()).toEqual([
      'NEW_FOLLOWER',
      'POST_COMMENT',
      'POST_REACTION',
    ]);
    const reaction = res.items.find((n: { type: string }) => n.type === 'POST_REACTION');
    expect(reaction.actor.id).toBe(fan.id);
    expect(reaction.post).toMatchObject({ id: post.id, format: 'PHOTO' });
    expect(reaction.post.thumbnailUrl).toMatch(/^http/);
    expect(reaction.post.captionExcerpt).toBe(
      'Sunrise intervals at the track, felt incredible today',
    );
    expect(reaction.data).toEqual({ reaction: 'FIRE' });
    const comment = res.items.find((n: { type: string }) => n.type === 'POST_COMMENT');
    expect(comment.comment.excerpt).toBe('Beast mode 🔥');
    expect(comment.readAt).toBeNull();
    expect(res.items.find((n: { type: string }) => n.type === 'NEW_FOLLOWER').post).toBeNull();
  }, 60_000);

  it("tracks unread state: count, mark specific ids, mark all, never someone else's", async () => {
    const author = await signupUser(t);
    const other = await signupUser(t);
    const fans = await Promise.all([signupUser(t), signupUser(t), signupUser(t)]);
    for (const f of fans) await api(t, f).post(`/users/${author.id}/follow`);
    await api(t, other).post(`/users/${fans[0]?.id}/follow`);

    expect((await api(t, author).get('/notifications/unread-count')).json()).toEqual({ count: 3 });
    const items = (await list(author)).items;
    expect(
      (await api(t, author).post('/notifications/read', { ids: [items[0].id] })).json(),
    ).toEqual({ updated: 1 });
    expect((await api(t, author).get('/notifications/unread-count')).json()).toEqual({ count: 2 });
    expect((await list(author, '?unreadOnly=true')).items).toHaveLength(2);

    // Someone else's notification id is silently ignored (no cross-user writes, no existence leak).
    const theirs = (await list(fans[0])).items[0];
    expect((await api(t, author).post('/notifications/read', { ids: [theirs.id] })).json()).toEqual(
      { updated: 0 },
    );
    expect((await list(fans[0])).items[0].readAt).toBeNull();

    expect((await api(t, author).post('/notifications/read', { all: true })).json()).toEqual({
      updated: 2,
    });
    expect((await api(t, author).get('/notifications/unread-count')).json()).toEqual({ count: 0 });
    expect((await api(t, author).post('/notifications/read', {})).statusCode).toBe(422);
    expect(
      (await api(t, author).post('/notifications/read', { ids: [items[0].id], all: true }))
        .statusCode,
    ).toBe(422);
  });

  it('paginates newest-first with a stable cursor', async () => {
    const author = await signupUser(t);
    for (let i = 0; i < 5; i++)
      await api(t, await signupUser(t)).post(`/users/${author.id}/follow`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await api(t, author).get(
        `/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const body: { items: Array<{ id: string }>; nextCursor: string | null } = page.json();
      seen.push(...body.items.map((n) => n.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(errorCode(await api(t, author).get('/notifications?cursor=junk'))).toBe(
      'INVALID_CURSOR',
    );
  });

  it("hides notifications about content that is gone, hidden, or out of the viewer's audience", async () => {
    const author = await signupUser(t);
    const fan = await signupUser(t);
    const keep = await createPost(t, author, { caption: 'keep' });
    const doomed = await createPost(t, author, { caption: 'doomed' });
    const moderated = await createPost(t, author, { caption: 'moderated' });
    for (const p of [keep, doomed, moderated])
      await api(t, fan).put(`/posts/${p.id}/reaction`, { type: 'LIKE' });
    expect((await list(author)).items).toHaveLength(3);

    await api(t, author).del(`/posts/${doomed.id}`);
    expect((await list(author)).items).toHaveLength(2);
    await t.platform.db
      .updateTable('posts')
      .set({ moderationStatus: 'REMOVED' })
      .where('id', '=', moderated.id)
      .execute();
    // The author may still see notifications about their own moderated post (so they understand what happened).
    expect((await list(author)).items).toHaveLength(2);

    // A viewer's notification about someone else's post vanishes when it leaves their audience.
    const other = await signupUser(t);
    const theirPost = await createPost(t, other, { caption: 'mine' });
    await api(t, fan).post(`/posts/${theirPost.id}/comments`, { body: 'hi' });
    await api(t, other).post(`/posts/${theirPost.id}/comments`, {
      body: 'hello back',
      parentId: (await api(t, other).get(`/posts/${theirPost.id}/comments`)).json().items[0].id,
    });
    expect(await types(fan)).toContain('COMMENT_REPLY');
    await api(t, other).patch(`/posts/${theirPost.id}`, { visibility: 'PRIVATE' });
    expect(await types(fan)).not.toContain('COMMENT_REPLY');
  });

  it('removes notifications to and from a blocked user, in both directions', async () => {
    const a = await signupUser(t);
    const b = await signupUser(t);
    await api(t, b).post(`/users/${a.id}/follow`);
    const post = await createPost(t, a, { caption: 'x' });
    await api(t, b).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
    expect((await list(a)).items).toHaveLength(2);
    await api(t, a).put(`/users/${b.id}/block`);
    expect((await list(a)).items).toEqual([]);
    expect((await api(t, a).get('/notifications/unread-count')).json()).toEqual({ count: 0 });
  });

  it('surfaces pending follow requests with an id you can act on inline', async () => {
    const owner = await signupUser(t, { isPrivate: true });
    const requester = await signupUser(t);
    await api(t, requester).post(`/users/${owner.id}/follow`);
    const n = (await list(owner)).items[0];
    expect(n.type).toBe('FOLLOW_REQUEST');
    expect(n.actor.id).toBe(requester.id);
    expect(n.followRequestId).toEqual(expect.any(String));
    await api(t, owner).post(`/me/follow-requests/${n.followRequestId}/accept`);
    expect(await types(owner)).toEqual(['NEW_FOLLOWER']); // request notification retracted, new follower recorded
    expect(await types(requester)).toEqual(['FOLLOW_ACCEPTED']);
  });

  describe('preferences', () => {
    it('default to everything on, and turning a type off stops it being recorded (and pushed)', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const defaults = (await api(t, author).get('/me/notification-preferences')).json();
      expect(defaults.items.length).toBeGreaterThan(8);
      expect(
        defaults.items.every((p: { inApp: boolean; push: boolean }) => p.inApp && p.push),
      ).toBe(true);

      const updated = (
        await api(t, author).put('/me/notification-preferences', {
          items: [{ type: 'POST_REACTION', inApp: false, push: true }],
        })
      ).json();
      expect(updated.items.find((p: { type: string }) => p.type === 'POST_REACTION')).toEqual({
        type: 'POST_REACTION',
        inApp: false,
        push: false,
      }); // push requires in-app
      const post = await createPost(t, author);
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, fan).post(`/posts/${post.id}/comments`, { body: 'hi' });
      expect(await types(author)).toEqual(['POST_COMMENT']); // reaction suppressed, comment still arrives
      expect(
        (
          await api(t, author).put('/me/notification-preferences', {
            items: [{ type: 'NOPE', inApp: true, push: true }],
          })
        ).statusCode,
      ).toBe(422);
    });
  });

  describe('push', () => {
    it('delivers to registered devices only, with sensible text and deep-link data', async () => {
      push.sent = [];
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const post = await createPost(t, author);

      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await drainJobs(t);
      expect(push.sent).toHaveLength(0); // no device registered: no job, nothing sent

      expect(
        (
          await api(t, author).put('/me/device/push-token', {
            provider: 'EXPO',
            token: 'ExponentPushToken[abcdefghijklmnop]',
          })
        ).statusCode,
      ).toBe(204);
      await api(t, fan).post(`/posts/${post.id}/comments`, { body: 'Great effort today!' });
      await drainJobs(t);
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]).toMatchObject({
        provider: 'EXPO',
        token: 'ExponentPushToken[abcdefghijklmnop]',
        title: 'New comment',
        body: `${(await api(t, fan).get('/me')).json().profile.displayName} commented: Great effort today!`,
        data: { type: 'POST_COMMENT', postId: post.id },
      });
    });

    it("registers tokens for the session's device, moves a token between accounts, and removes it", async () => {
      const a = await signupUser(t);
      const b = await signupUser(t);
      const token = 'shared-phone-token-0000001';
      await api(t, a).put('/me/device/push-token', { provider: 'FCM', token });
      await api(t, b).put('/me/device/push-token', { provider: 'FCM', token }); // same physical phone, new account
      const holders = await t.platform.db
        .selectFrom('devices')
        .select('userId')
        .where('pushToken', '=', token)
        .execute();
      expect(holders).toEqual([{ userId: b.id }]); // exactly one device owns a token

      expect((await api(t, b).del('/me/device/push-token')).statusCode).toBe(204);
      expect(
        await t.platform.db
          .selectFrom('devices')
          .select('id')
          .where('pushToken', '=', token)
          .execute(),
      ).toEqual([]);
    });

    it('needs installId+platform when the session has no device, and validates the body', async () => {
      const bare = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: 'nodevice@example.test',
          password: 'Correct-Horse-Battery-9',
          username: 'nodevice',
          birthDate: '1990-01-01',
        },
      });
      const headers = { authorization: `Bearer ${bare.json().tokens.accessToken as string}` };
      const put = (body: object) =>
        t.app.inject({
          method: 'PUT',
          url: '/v1/me/device/push-token',
          headers,
          payload: body as Record<string, unknown>,
        });
      expect((await put({ provider: 'APNS', token: 'apns-token-0123456789' })).statusCode).toBe(
        422,
      );
      expect(
        (
          await put({
            provider: 'APNS',
            token: 'apns-token-0123456789',
            installId: 'install-bare-0001',
            platform: 'IOS',
          })
        ).statusCode,
      ).toBe(204);
      expect((await put({ provider: 'APNS', token: 'short' })).statusCode).toBe(422);
      expect(
        (await put({ provider: 'SMOKE_SIGNAL', token: 'apns-token-0123456789' })).statusCode,
      ).toBe(422);
    });

    it('drops tokens the provider reports as dead, and skips notifications already read', async () => {
      push.sent = [];
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const post = await createPost(t, author);
      const token = 'dead-token-0000000001';
      push.invalidTokens.add(token);
      await api(t, author).put('/me/device/push-token', { provider: 'FCM', token });
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await drainJobs(t);
      expect(
        await t.platform.db
          .selectFrom('devices')
          .select('id')
          .where('pushToken', '=', token)
          .execute(),
      ).toEqual([]); // cleaned up

      const live = 'live-token-00000000001';
      await api(t, author).put('/me/device/push-token', { provider: 'FCM', token: live });
      await api(t, fan).post(`/posts/${post.id}/comments`, { body: 'x' });
      await api(t, author).post('/notifications/read', { all: true }); // seen in-app before the push job ran
      await drainJobs(t);
      expect(push.sent).toHaveLength(0);
    });
  });

  it('renders short, safe push text for every notification type', () => {
    const types = [
      'NEW_FOLLOWER',
      'FOLLOW_REQUEST',
      'FOLLOW_ACCEPTED',
      'POST_REACTION',
      'POST_COMMENT',
      'COMMENT_REPLY',
      'COMMENT_REACTION',
      'MENTION_POST',
      'MENTION_COMMENT',
      'POST_PUBLISHED',
      'POST_PUBLISH_FAILED',
      'MODERATION_ACTION',
    ] as const;
    for (const type of types) {
      const { title, body } = renderPush(type, 'Ava', { excerpt: 'nice one' });
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeLessThan(160);
    }
  });

  it('requires authentication and survives expired tokens', async () => {
    expect((await api(t).get('/notifications')).statusCode).toBe(401);
    const u = await signupUser(t);
    t.clock.advanceSeconds(t.config.ACCESS_TOKEN_TTL_SECONDS + 5);
    expect(errorCode(await api(t, u).get('/notifications'))).toBe('TOKEN_EXPIRED');
    expect((await api(t, await relogin(t, u)).get('/notifications')).statusCode).toBe(200);
  });

  it('keeps follow state notifications consistent when following/unfollowing repeatedly', async () => {
    const a = await signupUser(t);
    const b = await signupUser(t);
    await follow(t, b, a);
    await api(t, b).del(`/users/${a.id}/follow`);
    expect(await types(a)).toEqual([]);
    await api(t, b).post(`/users/${a.id}/follow`);
    await api(t, b).post(`/users/${a.id}/follow`);
    expect(await types(a)).toEqual(['NEW_FOLLOWER']); // one, not two
  });
});
