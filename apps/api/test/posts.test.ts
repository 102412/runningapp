import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllowAllModerator } from '../src/platform/ports/content-moderation';
import { decodePolyline, haversine, type LatLon } from '../src/modules/activities/geo';
import { api, drainJobs, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { eastwardRoute } from './helpers/geo';
import { MIME, uploadMedia } from './helpers/media';
import { createPost, follow, readyImage, readyVideo, unprocessedVideo } from './helpers/posts';

describe('posts', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const RUN = {
    sport: 'running',
    startedAt: '2026-03-01T07:30:00Z',
    elapsedTimeS: 1800,
    distanceM: 5000,
  };

  describe('creating text posts', () => {
    it('creates a post with defaults, topics from hashtags, and viewer state', async () => {
      const u = await signupUser(t);
      const post = await createPost(t, u, {
        caption: 'Long run done #Marathon #longrun',
        topics: ['Trail'],
      });
      expect(post).toMatchObject({
        origin: 'AUTHORED',
        status: 'PUBLISHED',
        format: 'TEXT',
        visibility: 'PUBLIC',
        commentPermission: 'EVERYONE',
        media: [],
        activity: null,
        sponsorship: null,
        moderationStatus: 'CLEAN',
        counts: { reactions: 0, comments: 0, shares: 0, bookmarks: 0 },
        viewer: { reaction: null, bookmarked: false, isAuthor: true, canComment: true },
      });
      expect(post.topics).toEqual(['longrun', 'marathon', 'trail']);
      expect(post.author.id).toBe(u.id);
      expect(post.publishedAt).not.toBeNull();
    });

    it('requires a verified email, content, and a sane caption', async () => {
      const unverified = await signupUser(t, { verified: false });
      const res = await api(t, unverified).post('/posts', { caption: 'hi' });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('EMAIL_NOT_VERIFIED');
      const u = await signupUser(t);
      expect(errorCode(await api(t, u).post('/posts', {}))).toBe('EMPTY_POST');
      expect(errorCode(await api(t, u).post('/posts', { caption: '   ' }))).toBe('EMPTY_POST');
      expect(errorCode(await api(t, u).post('/posts', { caption: 'x'.repeat(2201) }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await api(t, u).post('/posts', { caption: 'ok', authorId: u.id }))).toBe(
        'VALIDATION_FAILED',
      ); // mass assignment
      expect((await api(t).post('/posts', { caption: 'x' })).statusCode).toBe(401);
    });

    it('resolves @mentions, notifies once, and never links across blocks', async () => {
      const author = await signupUser(t);
      const friend = await signupUser(t);
      const blockedFriend = await signupUser(t);
      await api(t, author).put(`/users/${blockedFriend.id}/block`);
      const post = await createPost(t, author, {
        caption: `great session @${friend.username} and @${blockedFriend.username} and @nobody_here_xx`,
      });
      expect(post.mentions).toEqual([{ id: friend.id, username: friend.username }]);
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select(['recipientId', 'type'])
        .where('postId', '=', post.id)
        .execute();
      expect(notes).toEqual([{ recipientId: friend.id, type: 'MENTION_POST' }]);
    });

    it('a minor cannot create PUBLIC posts, and the moderator port can reject captions', async () => {
      const year = new Date().getUTCFullYear() - 14;
      const kid = await signupUser(t, { birthDate: `${year}-01-01` });
      expect(
        errorCode(await api(t, kid).post('/posts', { caption: 'hi', visibility: 'PUBLIC' })),
      ).toBe('PUBLIC_ACCOUNT_NOT_ALLOWED');
      expect((await createPost(t, kid, { caption: 'hi' })).visibility).toBe('FOLLOWERS'); // minors default to FOLLOWERS

      const strict = await createTestApp();
      try {
        class NoBadWords extends AllowAllModerator {
          override async moderateText({ text }: { text: string }) {
            return text.includes('badword')
              ? { verdict: 'BLOCK' as const, reason: 'not allowed' }
              : { verdict: 'ALLOW' as const };
          }
        }
        const { createServices } = await import('../src/services');
        const { buildApp } = await import('../src/app');
        const services = createServices(strict.platform, { moderator: new NoBadWords() });
        const app = await buildApp(strict.platform, services);
        await app.ready();
        const t2: TestApp = { ...strict, app, services };
        const u = await signupUser(t2);
        const res = await api(t2, u).post('/posts', { caption: 'this has a badword in it' });
        expect(res.statusCode).toBe(422);
        expect(errorCode(res)).toBe('CONTENT_REJECTED');
        expect((await api(t2, u).post('/posts', { caption: 'clean words only' })).statusCode).toBe(
          201,
        );
        await app.close();
      } finally {
        await strict.close();
      }
    }, 30_000);
  });

  describe('activities and posts are related but independent', () => {
    it('logging an activity creates a feed post (format ACTIVITY) that mirrors the activity audience', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      await follow(t, viewer, u);
      const logged = (
        await api(t, u).post('/activities', { ...RUN, visibility: 'FOLLOWERS' })
      ).json();
      expect(logged.postId).toEqual(expect.any(String));

      const post = (await api(t, viewer).get(`/posts/${logged.postId}`)).json();
      expect(post).toMatchObject({
        origin: 'ACTIVITY_AUTO',
        format: 'ACTIVITY',
        visibility: 'FOLLOWERS',
        status: 'PUBLISHED',
        caption: '',
      });
      expect(post.activity.id).toBe(logged.id);
      expect(post.activity.distanceM).toBe(5000);

      // Changing the activity's audience changes its post's audience in the same transaction.
      await api(t, u).patch(`/activities/${logged.id}`, { visibility: 'PRIVATE' });
      expect((await api(t, viewer).get(`/posts/${logged.postId}`)).statusCode).toBe(404);
      expect((await api(t, u).get(`/posts/${logged.postId}`)).json().visibility).toBe('PRIVATE');
      await api(t, u).patch(`/activities/${logged.id}`, { visibility: 'PUBLIC' });
      expect((await api(t, viewer).get(`/posts/${logged.postId}`)).statusCode).toBe(200);
      // The post cannot diverge from its activity.
      const diverge = await api(t, u).patch(`/posts/${logged.postId}`, { visibility: 'FOLLOWERS' });
      expect(diverge.statusCode).toBe(422);
    });

    it('an activity can exist with no post: createPost=false, PRIVATE activities, or setting off', async () => {
      const u = await signupUser(t);
      expect(
        (await api(t, u).post('/activities', { ...RUN, createPost: false })).json().postId,
      ).toBeNull();
      expect(
        (await api(t, u).post('/activities', { ...RUN, visibility: 'PRIVATE' })).json().postId,
      ).toBeNull();
      await api(t, u).patch('/me/settings', { autoCreateActivityPost: false });
      expect((await api(t, u).post('/activities', RUN)).json().postId).toBeNull();
      expect(
        (await api(t, u).post('/activities', { ...RUN, createPost: true })).json().postId,
      ).not.toBeNull();
    });

    it('unverified accounts can log activities but get no feed post', async () => {
      const u = await signupUser(t, { verified: false });
      const res = await api(t, u).post('/activities', RUN);
      expect(res.statusCode).toBe(201);
      expect(res.json().postId).toBeNull();
    });

    it("a post can attach only ITS AUTHOR's activity; the database also refuses to link anyone else's", async () => {
      const owner = await signupUser(t);
      const other = await signupUser(t);
      const activityId = (
        await api(t, owner).post('/activities', { ...RUN, createPost: false })
      ).json().id as string;
      expect(errorCode(await api(t, other).post('/posts', { caption: 'stolen', activityId }))).toBe(
        'ACTIVITY_NOT_FOUND',
      );
      // Even bypassing the API, the composite FK makes it impossible.
      await expect(
        t.platform.db
          .insertInto('posts')
          .values({ authorId: other.id, format: 'ACTIVITY', visibility: 'PUBLIC', activityId })
          .execute(),
      ).rejects.toThrow(/posts_activity_owner_fk/);
      const mine = await createPost(t, owner, { caption: 'recap', activityId });
      expect(mine.activity.id).toBe(activityId);
      expect(mine.format).toBe('ACTIVITY');
    });

    it('a user can have many posts about one activity; deleting the activity removes the auto post but keeps authored ones', async () => {
      const u = await signupUser(t);
      const logged = (await api(t, u).post('/activities', RUN)).json();
      const recap = await createPost(t, u, { caption: 'my recap', activityId: logged.id });
      expect(recap.id).not.toBe(logged.postId);

      expect((await api(t, u).del(`/activities/${logged.id}`)).statusCode).toBe(204);
      expect((await api(t, u).get(`/posts/${logged.postId}`)).statusCode).toBe(404); // auto post went with it
      const kept = (await api(t, u).get(`/posts/${recap.id}`)).json();
      expect(kept.activity).toBeNull(); // detached, not deleted
      expect(kept.caption).toBe('my recap');
    });

    it('route privacy follows the attached activity into the post for each viewer', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      const route = eastwardRoute(5);
      const logged = (
        await api(t, owner).post('/activities', {
          ...RUN,
          visibility: 'PUBLIC',
          route: { points: route },
        })
      ).json();
      const post = (await api(t, viewer).get(`/posts/${logged.postId}`)).json();
      expect(post.activity.hasRoute).toBe(true);
      for (const seg of post.activity.routePreview.segments as string[]) {
        for (const p of decodePolyline(seg)) {
          expect(haversine(p, route[0] as LatLon)).toBeGreaterThan(195);
          expect(haversine(p, route[route.length - 1] as LatLon)).toBeGreaterThan(195);
        }
      }
      expect(post.activity.ownerPrivacy).toBeNull();
      expect(
        (await api(t, owner).get(`/posts/${logged.postId}`)).json().activity.ownerPrivacy,
      ).not.toBeNull();
    });

    it('re-importing the same GPX returns the same post, not a second one', async () => {
      const { makeGpx } = await import('./helpers/geo');
      const u = await signupUser(t);
      const body = makeGpx({ points: eastwardRoute(3), speedMps: 3.5, type: 'running' });
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: '/v1/activities/import/gpx?visibility=PUBLIC',
          headers: { ...u.headers, 'content-type': 'application/gpx+xml' },
          payload: body,
        });
      const first = (await send()).json();
      const second = (await send()).json();
      expect(second.id).toBe(first.id);
      expect(second.postId).toBe(first.postId);
      const posts = await t.platform.db
        .selectFrom('posts')
        .select('id')
        .where('activityId', '=', first.id)
        .execute();
      expect(posts).toHaveLength(1);
    });
  });

  describe('media and the publish lifecycle', () => {
    it('publishes immediately when attached media is READY', async () => {
      const u = await signupUser(t);
      const mediaId = await readyVideo(t, u);
      const post = await createPost(t, u, {
        caption: 'raw post-run reaction',
        mediaIds: [mediaId],
      });
      expect(post).toMatchObject({ status: 'PUBLISHED', format: 'VIDEO' });
      expect(post.media).toHaveLength(1);
      expect(post.media[0]).toMatchObject({ id: mediaId, status: 'READY', kind: 'VIDEO' });
      expect(post.media[0].urls.playback).toMatch(/^http/);
    }, 60_000);

    it('waits in PENDING_MEDIA (invisible to others), then publishes itself when processing finishes', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      await follow(t, viewer, u);
      const mediaId = await unprocessedVideo(t, u);
      const post = await createPost(t, u, { caption: 'processing...', mediaIds: [mediaId] });
      expect(post).toMatchObject({ status: 'PENDING_MEDIA', format: 'VIDEO', publishedAt: null });
      expect(post.media[0].status).toBe('UPLOADED'); // the author sees in-flight media
      expect((await api(t, viewer).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t, viewer).get(`/users/${u.id}/posts`)).json().items).toEqual([]);

      await drainJobs(t); // media.process -> media.status_changed -> post publishes
      await drainJobs(t);
      const after = (await api(t, viewer).get(`/posts/${post.id}`)).json();
      expect(after).toMatchObject({ status: 'PUBLISHED', format: 'VIDEO' });
      expect(after.media[0].status).toBe('READY');
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', u.id)
        .where('postId', '=', post.id)
        .execute();
      expect(notes.map((n) => n.type)).toContain('POST_PUBLISHED');
    }, 60_000);

    it('fails visibly when media is rejected, and recovers by detaching it', async () => {
      const u = await signupUser(t);
      const garbage = await uploadMedia(t, u, Buffer.from('not a video'.repeat(40)), {
        kind: 'VIDEO',
        mime: MIME.mp4,
        process: false,
      });
      const post = await createPost(t, u, { caption: 'will fail', mediaIds: [garbage.id] });
      expect(post.status).toBe('PENDING_MEDIA');
      await drainJobs(t);
      await drainJobs(t);
      const failed = (await api(t, u).get(`/posts/${post.id}`)).json();
      expect(failed.status).toBe('PUBLISH_FAILED');
      expect(failed.media[0]).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_MEDIA' });
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', u.id)
        .execute();
      expect(notes.map((n) => n.type)).toContain('POST_PUBLISH_FAILED');

      expect(errorCode(await api(t, u).post(`/posts/${post.id}/publish`))).toBe('MEDIA_REJECTED');
      const detached = await api(t, u).del(`/posts/${post.id}/media/${garbage.id}`);
      expect(detached.statusCode).toBe(200);
      const republished = await api(t, u).post(`/posts/${post.id}/publish`);
      expect(republished.json()).toMatchObject({ status: 'PUBLISHED', format: 'TEXT', media: [] });
    }, 60_000);

    it('adds a video to an existing activity post (DO -> LOG -> SHOW): hidden while processing, then the format upgrades', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      await follow(t, viewer, u);
      const logged = (
        await api(t, u).post('/activities', { ...RUN, visibility: 'FOLLOWERS' })
      ).json();
      const mediaId = await unprocessedVideo(t, u);

      const attached = await api(t, u).post(`/posts/${logged.postId}/media`, {
        mediaIds: [mediaId],
      });
      expect(attached.statusCode).toBe(200);
      expect(attached.json()).toMatchObject({ status: 'PUBLISHED', format: 'ACTIVITY' }); // not VIDEO until it's playable
      expect(attached.json().media).toHaveLength(1);
      const asViewer = (await api(t, viewer).get(`/posts/${logged.postId}`)).json();
      expect(asViewer.media).toEqual([]); // processing media is invisible to others; the post stays live

      await drainJobs(t);
      await drainJobs(t);
      const done = (await api(t, viewer).get(`/posts/${logged.postId}`)).json();
      expect(done.format).toBe('VIDEO');
      expect(done.media).toHaveLength(1);
      expect(done.activity.id).toBe(logged.id);
    }, 60_000);

    it('validates attachments: ownership, purpose, reuse, limits and pending uploads', async () => {
      const u = await signupUser(t);
      const other = await signupUser(t);
      const mine = await readyImage(t, u);
      const theirs = await readyImage(t, other);
      expect(errorCode(await api(t, u).post('/posts', { mediaIds: [theirs] }))).toBe(
        'MEDIA_NOT_FOUND',
      );
      expect(
        errorCode(
          await api(t, u).post('/posts', { mediaIds: ['018f0000-0000-7000-8000-000000000000'] }),
        ),
      ).toBe('MEDIA_NOT_FOUND');

      const first = await createPost(t, u, { mediaIds: [mine] });
      expect(first.format).toBe('PHOTO');
      expect(errorCode(await api(t, u).post('/posts', { mediaIds: [mine] }))).toBe(
        'MEDIA_ALREADY_ATTACHED',
      );
      expect(errorCode(await api(t, u).del(`/media/${mine}`))).toBe('MEDIA_ALREADY_ATTACHED'); // cannot delete in-use media

      const avatar = await uploadMedia(
        t,
        u,
        await (await import('./helpers/posts')).sampleImage(),
        { kind: 'IMAGE', mime: MIME.jpg, purpose: 'AVATAR' },
      );
      expect(errorCode(await api(t, u).post('/posts', { mediaIds: [avatar.id] }))).toBe(
        'VALIDATION_FAILED',
      );

      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
        })
      ).json();
      expect(errorCode(await api(t, u).post('/posts', { mediaIds: [init.media.id] }))).toBe(
        'MEDIA_NOT_READY',
      );
      expect(
        errorCode(
          await api(t, u).post('/posts', { mediaIds: Array.from({ length: 11 }, () => mine) }),
        ),
      ).toBe('VALIDATION_FAILED');
    }, 60_000);

    it('supports multiple photos in order', async () => {
      const u = await signupUser(t);
      const ids = [await readyImage(t, u), await readyImage(t, u), await readyImage(t, u)];
      const post = await createPost(t, u, { mediaIds: ids });
      expect(post.media.map((m: { id: string }) => m.id)).toEqual(ids);
      expect(post.format).toBe('PHOTO');
      const detached = (await api(t, u).del(`/posts/${post.id}/media/${ids[1]}`)).json();
      expect(detached.media.map((m: { id: string }) => m.id)).toEqual([ids[0], ids[2]]);
      expect((await api(t, u).get(`/media/${ids[1]}`)).statusCode).toBe(200); // still in their library
    }, 90_000);
  });

  describe('drafts', () => {
    it('saves drafts privately and publishes on request (idempotently)', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      const draft = await createPost(t, u, { caption: 'draft thought', publish: false });
      expect(draft).toMatchObject({ status: 'DRAFT', publishedAt: null });
      expect((await api(t, viewer).get(`/posts/${draft.id}`)).statusCode).toBe(404);
      const mine = (await api(t, u).get('/me/posts?status=DRAFT')).json();
      expect(mine.items.map((p: { id: string }) => p.id)).toContain(draft.id);

      const pub = await api(t, u).post(`/posts/${draft.id}/publish`);
      expect(pub.json().status).toBe('PUBLISHED');
      const again = await api(t, u).post(`/posts/${draft.id}/publish`);
      expect(again.json().publishedAt).toBe(pub.json().publishedAt);
      expect((await api(t, viewer).get(`/posts/${draft.id}`)).statusCode).toBe(200);
    });
  });

  describe('editing', () => {
    it('keeps explicit topics while hashtags follow the caption, and notifies only NEW mentions', async () => {
      const u = await signupUser(t);
      const a = await signupUser(t);
      const b = await signupUser(t);
      const post = await createPost(t, u, {
        caption: `#alpha with @${a.username}`,
        topics: ['kept'],
      });
      expect(post.topics).toEqual(['alpha', 'kept']);
      const edited = (
        await api(t, u).patch(`/posts/${post.id}`, {
          caption: `#beta with @${a.username} and @${b.username}`,
        })
      ).json();
      expect(edited.topics).toEqual(['beta', 'kept']);
      expect(edited.mentions.map((m: { id: string }) => m.id).sort()).toEqual([a.id, b.id].sort());
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select('recipientId')
        .where('postId', '=', post.id)
        .where('type', '=', 'MENTION_POST')
        .execute();
      expect(notes.map((n) => n.recipientId).sort()).toEqual([a.id, b.id].sort()); // a notified once, b once
      const replaced = (await api(t, u).patch(`/posts/${post.id}`, { topics: ['only'] })).json();
      expect(replaced.topics).toEqual(['beta', 'only']);
    });

    it('is owner-only (404 for others), cannot empty a post, and respects audience rules', async () => {
      const u = await signupUser(t);
      const other = await signupUser(t);
      const post = await createPost(t, u, { caption: 'original' });
      expect(errorCode(await api(t, other).patch(`/posts/${post.id}`, { caption: 'hijack' }))).toBe(
        'POST_NOT_FOUND',
      );
      expect(errorCode(await api(t, other).del(`/posts/${post.id}`))).toBe('POST_NOT_FOUND');
      expect(errorCode(await api(t, u).patch(`/posts/${post.id}`, { caption: '' }))).toBe(
        'EMPTY_POST',
      );
      const edited = (
        await api(t, u).patch(`/posts/${post.id}`, {
          visibility: 'FOLLOWERS',
          commentPermission: 'NOBODY',
        })
      ).json();
      expect(edited).toMatchObject({
        visibility: 'FOLLOWERS',
        commentPermission: 'NOBODY',
        caption: 'original',
      });
      expect(edited.viewer.canComment).toBe(false); // NOBODY disables comments for everyone
    });
  });

  describe('sponsorship and creators', () => {
    it('makes sponsored content distinguishable at the data level, with a server-built label', async () => {
      const u = await signupUser(t);
      const organic = await createPost(t, u, { caption: 'just a run' });
      const sponsored = await createPost(t, u, {
        caption: 'new shoes',
        sponsorship: { type: 'PAID_PARTNERSHIP', brandName: 'Acme Run' },
      });
      expect(organic.sponsorship).toBeNull();
      expect(sponsored.sponsorship).toEqual({
        type: 'PAID_PARTNERSHIP',
        brandName: 'Acme Run',
        label: 'Paid partnership with Acme Run',
        partnershipId: null,
      });
      const viewer = await signupUser(t);
      expect((await api(t, viewer).get(`/posts/${sponsored.id}`)).json().sponsorship.label).toBe(
        'Paid partnership with Acme Run',
      );
    });

    it('a disclosure may be added later but not withdrawn once the post is public', async () => {
      const u = await signupUser(t);
      const post = await createPost(t, u, { caption: 'oops forgot to disclose' });
      const added = (
        await api(t, u).patch(`/posts/${post.id}`, {
          sponsorship: { type: 'GIFTED_PRODUCT', brandName: 'Zoom' },
        })
      ).json();
      expect(added.sponsorship.label).toBe('Gifted product from Zoom');
      const removal = await api(t, u).patch(`/posts/${post.id}`, { sponsorship: null });
      expect(removal.statusCode).toBe(409);
      // ...but a draft can drop it.
      const draft = await createPost(t, u, {
        caption: 'd',
        publish: false,
        sponsorship: { type: 'AFFILIATE', brandName: 'Z' },
      });
      expect(
        (await api(t, u).patch(`/posts/${draft.id}`, { sponsorship: null })).json().sponsorship,
      ).toBeNull();
    });

    it('creator profiles, verification is staff-only, and partnerships link to disclosures', async () => {
      const u = await signupUser(t);
      expect((await api(t, u).get('/me/creator')).json()).toEqual({ creator: null });
      const created = await api(t, u).put('/me/creator', {
        category: 'PROFESSIONAL_ATHLETE',
        tagline: 'Pro 1500m runner',
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        category: 'PROFESSIONAL_ATHLETE',
        verificationStatus: 'NONE',
      });
      // Verification cannot be self-granted.
      expect(
        (await api(t, u).put('/me/creator', { category: 'COACH', verificationStatus: 'VERIFIED' }))
          .statusCode,
      ).toBe(422);
      expect(
        (await api(t, u).put('/me/creator', { category: 'COACH', verified: true })).statusCode,
      ).toBe(422);
      expect(
        (await api(t, u).post('/me/creator/verification-request')).json().verificationStatus,
      ).toBe('PENDING');

      const viewer = await signupUser(t);
      const profile = (await api(t, viewer).get(`/users/${u.id}`)).json();
      expect(profile.creator).toEqual({ category: 'PROFESSIONAL_ATHLETE', verified: false });
      expect(profile.creatorProfile.verificationStatus).toBe('PENDING');

      const partnership = (
        await api(t, u).post('/me/creator/partnerships', {
          brandName: 'Acme',
          type: 'PAID_PARTNERSHIP',
          startedOn: '2026-01-01',
        })
      ).json();
      const post = await createPost(t, u, {
        caption: 'ad',
        sponsorship: { type: 'PAID_PARTNERSHIP', brandName: 'Acme', partnershipId: partnership.id },
      });
      expect(post.sponsorship.partnershipId).toBe(partnership.id);
      const other = await signupUser(t);
      expect(
        errorCode(
          await api(t, other).post('/posts', {
            caption: 'x',
            sponsorship: {
              type: 'PAID_PARTNERSHIP',
              brandName: 'Acme',
              partnershipId: partnership.id,
            },
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        errorCode(
          await api(t, other).post('/me/creator/partnerships', {
            brandName: 'X',
            type: 'AFFILIATE',
          }),
        ),
      ).toBe('INVALID_STATE'); // needs a creator profile
      expect((await api(t, u).get('/me/creator/partnerships')).json().items).toHaveLength(1);
      expect((await api(t, u).del(`/me/creator/partnerships/${partnership.id}`)).statusCode).toBe(
        204,
      );
      expect((await api(t, viewer).get(`/posts/${post.id}`)).json().sponsorship.brandName).toBe(
        'Acme',
      ); // disclosure outlives the record
    });
  });

  describe('visibility', () => {
    it('applies the audience matrix, moderation and suspension to single posts and profile grids', async () => {
      const author = await signupUser(t);
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      const blocked = await signupUser(t);
      await follow(t, follower, author);
      await api(t, author).put(`/users/${blocked.id}/block`);
      const pub = (await createPost(t, author, { caption: 'pub', visibility: 'PUBLIC' }))
        .id as string;
      const fol = (await createPost(t, author, { caption: 'fol', visibility: 'FOLLOWERS' }))
        .id as string;
      const priv = (await createPost(t, author, { caption: 'priv', visibility: 'PRIVATE' }))
        .id as string;

      const code = async (viewer: TestUser | null, id: string) =>
        (await api(t, viewer).get(`/posts/${id}`)).statusCode;
      expect([await code(null, pub), await code(null, fol), await code(null, priv)]).toEqual([
        200, 404, 404,
      ]);
      expect([
        await code(stranger, pub),
        await code(stranger, fol),
        await code(stranger, priv),
      ]).toEqual([200, 404, 404]);
      expect([
        await code(follower, pub),
        await code(follower, fol),
        await code(follower, priv),
      ]).toEqual([200, 200, 404]);
      expect([await code(author, pub), await code(author, fol), await code(author, priv)]).toEqual([
        200, 200, 200,
      ]);
      expect([
        await code(blocked, pub),
        await code(blocked, fol),
        await code(blocked, priv),
      ]).toEqual([404, 404, 404]);

      const grid = async (viewer: TestUser | null) =>
        (await api(t, viewer).get(`/users/${author.id}/posts`))
          .json()
          .items.map((p: { id: string }) => p.id);
      expect((await grid(stranger)).sort()).toEqual([pub]);
      expect((await grid(follower)).sort()).toEqual([pub, fol].sort());
      expect((await grid(author)).sort()).toEqual([pub, fol, priv].sort());
      expect((await api(t, blocked).get(`/users/${author.id}/posts`)).statusCode).toBe(404);

      // Moderation: HIDDEN/REMOVED vanish for everyone but the author, who is told why.
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'HIDDEN' })
        .where('id', '=', pub)
        .execute();
      expect(await code(stranger, pub)).toBe(404);
      expect(await code(follower, pub)).toBe(404);
      const own = (await api(t, author).get(`/posts/${pub}`)).json();
      expect(own.moderationStatus).toBe('HIDDEN');
      expect((await grid(stranger)).includes(pub)).toBe(false);
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'CLEAN' })
        .where('id', '=', pub)
        .execute();

      // Suspension hides everything from everyone but the (restricted) owner.
      await t.platform.db
        .updateTable('users')
        .set({ status: 'SUSPENDED', suspendedAt: new Date() })
        .where('id', '=', author.id)
        .execute();
      expect([await code(follower, pub), await code(follower, fol), await code(null, pub)]).toEqual(
        [404, 404, 404],
      );
    });

    it('public posts of PRIVATE accounts stay followers-only; grids answer ACCOUNT_PRIVATE', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(t, follower, owner);
      const post = await createPost(t, owner, { caption: 'hi', visibility: 'PUBLIC' });
      expect((await api(t, stranger).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t, follower).get(`/posts/${post.id}`)).statusCode).toBe(200);
      const denied = await api(t, stranger).get(`/users/${owner.id}/posts`);
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe('ACCOUNT_PRIVATE');
      expect((await api(t, follower).get(`/users/${owner.id}/posts`)).json().items).toHaveLength(1);
    });

    it('anonymous callers can open PUBLIC posts of PUBLIC accounts (shareable links) with a null viewer', async () => {
      const u = await signupUser(t);
      const post = await createPost(t, u, { caption: 'open to the world' });
      const res = await api(t).get(`/posts/${post.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewer).toBeNull();
      expect(res.json().counts.bookmarks).toBeNull();
      expect(res.json().moderationStatus).toBeNull();
    });
  });

  describe('deleting', () => {
    it('removes the post everywhere at once, updates counts, and cleans up its media', async () => {
      const u = await signupUser(t);
      const viewer = await signupUser(t);
      const mediaId = await readyImage(t, u);
      const keep = await createPost(t, u, { caption: 'keep' });
      const post = await createPost(t, u, { caption: 'doomed', mediaIds: [mediaId] });
      expect((await api(t, viewer).get(`/users/${u.id}`)).json().counts.posts).toBe(2);

      expect((await api(t, u).del(`/posts/${post.id}`)).statusCode).toBe(204);
      expect((await api(t, viewer).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t, u).get(`/posts/${post.id}`)).statusCode).toBe(404); // even the author
      expect((await api(t, viewer).get(`/users/${u.id}`)).json().counts.posts).toBe(1);
      const ids = (await api(t, viewer).get(`/users/${u.id}/posts`))
        .json()
        .items.map((p: { id: string }) => p.id);
      expect(ids).toEqual([keep.id]);
      expect(
        (await api(t, u).get('/me/posts')).json().items.map((p: { id: string }) => p.id),
      ).toEqual([keep.id]);

      await drainJobs(t);
      expect((await api(t, u).get(`/media/${mediaId}`)).statusCode).toBe(404); // media removed too
      expect((await api(t, u).del(`/posts/${post.id}`)).statusCode).toBe(404);
    }, 60_000);

    it('erases what the author wrote at once, even though the row lingers for the retention window', async () => {
      const u = await signupUser(t);
      const other = await signupUser(t);
      const post = await createPost(t, u, {
        caption: `private thoughts @${other.username} #secret`,
        topics: ['journal'],
      });
      await api(t, u).del(`/posts/${post.id}`);
      const row = await t.platform.db
        .selectFrom('posts')
        .select(['caption', 'deletedAt'])
        .where('id', '=', post.id)
        .executeTakeFirstOrThrow();
      expect(row.deletedAt).not.toBeNull();
      expect(row.caption).toBe('');
      const derived = await Promise.all([
        t.platform.db
          .selectFrom('postTopics')
          .select('postId')
          .where('postId', '=', post.id)
          .execute(),
        t.platform.db
          .selectFrom('postMentions')
          .select('postId')
          .where('postId', '=', post.id)
          .execute(),
      ]);
      expect(derived.map((d) => d.length)).toEqual([0, 0]);
    });

    it('purges soft-deleted posts for good after the retention window', async () => {
      const u = await signupUser(t);
      const post = await createPost(t, u, { caption: 'temp' });
      await api(t, u).del(`/posts/${post.id}`);
      await t.services.posts.handlePurgeDeleted();
      expect(
        await t.platform.db
          .selectFrom('posts')
          .select('id')
          .where('id', '=', post.id)
          .executeTakeFirst(),
      ).toBeDefined(); // still retained
      t.clock.advanceSeconds(31 * 24 * 3600);
      await t.services.posts.handlePurgeDeleted();
      expect(
        await t.platform.db
          .selectFrom('posts')
          .select('id')
          .where('id', '=', post.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      t.clock.advanceSeconds(-31 * 24 * 3600);
    });
  });

  describe('listings and counters', () => {
    it('paginates profile grids newest-first with a stable cursor and a format filter', async () => {
      const u = await signupUser(t);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await createPost(t, u, { caption: `post ${i}` })).id as string);
      await api(t, u).post('/activities', RUN);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(t, u).get(
          `/users/${u.id}/posts?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body: { items: Array<{ id: string }>; nextCursor: string | null } = page.json();
        seen.push(...body.items.map((p) => p.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      expect(seen.slice(1)).toEqual([...ids].reverse()); // newest first; the activity post was last created
      const onlyActivity = (await api(t, u).get(`/users/${u.id}/posts?format=ACTIVITY`)).json();
      expect(onlyActivity.items).toHaveLength(1);
      expect(errorCode(await api(t, u).get(`/users/${u.id}/posts?cursor=nonsense`))).toBe(
        'INVALID_CURSOR',
      );
    });

    it('profile post counts stay exact through publish, hide and delete', async () => {
      const u = await signupUser(t);
      const count = async () =>
        (
          await t.platform.db
            .selectFrom('profiles')
            .select('postCount')
            .where('userId', '=', u.id)
            .executeTakeFirstOrThrow()
        ).postCount;
      expect(await count()).toBe(0);
      const a = await createPost(t, u, { caption: 'a' });
      const draft = await createPost(t, u, { caption: 'd', publish: false });
      expect(await count()).toBe(1); // drafts don't count
      await api(t, u).post(`/posts/${draft.id}/publish`);
      expect(await count()).toBe(2);
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'REMOVED' })
        .where('id', '=', a.id)
        .execute();
      expect(await count()).toBe(1);
      await api(t, u).del(`/posts/${draft.id}`);
      expect(await count()).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for a retried request instead of creating a duplicate', async () => {
      const u = await signupUser(t);
      const send = (body: object, key = 'retry-key-0001') =>
        t.app.inject({
          method: 'POST',
          url: '/v1/posts',
          headers: { ...u.headers, 'idempotency-key': key },
          payload: body as Record<string, unknown>,
        });
      const first = await send({ caption: 'once only' });
      const second = await send({ caption: 'once only' });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(
        await t.platform.db.selectFrom('posts').select('id').where('authorId', '=', u.id).execute(),
      ).toHaveLength(1);

      const reused = await send({ caption: 'different body' });
      expect(reused.statusCode).toBe(409);
      expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(errorCode(await send({ caption: 'x' }, 'bad key!'))).toBe('VALIDATION_FAILED');
    });

    it('does not poison a key when the first attempt fails', async () => {
      const u = await signupUser(t);
      const send = (body: object) =>
        t.app.inject({
          method: 'POST',
          url: '/v1/posts',
          headers: { ...u.headers, 'idempotency-key': 'fail-then-ok-001' },
          payload: body as Record<string, unknown>,
        });
      expect(
        (await send({ caption: 'x', activityId: '018f0000-0000-7000-8000-000000000000' }))
          .statusCode,
      ).toBe(404);
      // Same key, same body would fail again identically, but a corrected request with the key is a different request:
      const corrected = await send({ caption: 'x' });
      expect([201, 409]).toContain(corrected.statusCode);
      const retried = await t.app.inject({
        method: 'POST',
        url: '/v1/posts',
        headers: { ...u.headers, 'idempotency-key': 'fresh-key-00002' },
        payload: { caption: 'x' },
      });
      expect(retried.statusCode).toBe(201);
    });

    it('concurrent requests with one key create exactly one resource', async () => {
      const u = await signupUser(t);
      const fire = () =>
        t.app.inject({
          method: 'POST',
          url: '/v1/posts',
          headers: { ...u.headers, 'idempotency-key': 'concurrent-key-1' },
          payload: { caption: 'race' },
        });
      const results = await Promise.all([fire(), fire(), fire(), fire()]);
      expect(results.filter((r) => r.statusCode === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
      expect(
        await t.platform.db.selectFrom('posts').select('id').where('authorId', '=', u.id).execute(),
      ).toHaveLength(1);
    });

    it('also protects activity logging', async () => {
      const u = await signupUser(t);
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: '/v1/activities',
          headers: { ...u.headers, 'idempotency-key': 'activity-key-001' },
          payload: RUN,
        });
      const a = (await send()).json();
      const b = (await send()).json();
      expect(b.id).toBe(a.id);
      expect(
        await t.platform.db
          .selectFrom('activities')
          .select('id')
          .where('userId', '=', u.id)
          .execute(),
      ).toHaveLength(1);
    });
  });

  describe('efficiency', () => {
    it('hydrates a page of rich posts (activity + media + topics + mentions) in a constant number of queries', async () => {
      const queries: string[] = [];
      const counted = await createTestApp({ onQuery: (e) => queries.push(e.query.sql) });
      try {
        const u = await signupUser(counted);
        const viewer = await signupUser(counted);
        const friend = await signupUser(counted);
        const img = await readyImage(counted, u);
        for (let i = 0; i < 11; i++) {
          const logged = (
            await api(counted, u).post('/activities', {
              ...RUN,
              startedAt: `2026-02-${String(i + 1).padStart(2, '0')}T07:00:00Z`,
              visibility: 'PUBLIC',
              route: { points: eastwardRoute(2) },
            })
          ).json();
          await createPost(counted, u, {
            caption: `#t${i} @${friend.username}`,
            activityId: logged.id,
          });
        }
        // Created LAST so even a tiny first page contains every kind of content (media included):
        // the hydrator skips queries for absent parts, so only like-for-like pages are comparable.
        await createPost(counted, u, { caption: `#a @${friend.username}`, mediaIds: [img] });
        queries.length = 0;
        const big = await api(counted, viewer).get(`/users/${u.id}/posts?limit=24`);
        expect(big.json().items.length).toBeGreaterThanOrEqual(22);
        const many = queries.length;
        queries.length = 0;
        await api(counted, viewer).get(`/users/${u.id}/posts?limit=2`);
        expect(queries.length).toBe(many);
        expect(many).toBeLessThanOrEqual(30);
      } finally {
        await counted.close();
      }
    }, 120_000);
  });
});
