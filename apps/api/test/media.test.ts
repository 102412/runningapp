import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllowAllModerator } from '../src/platform/ports/content-moderation';
import { assertSafeKey } from '../src/platform/storage/types';
import { planImageVariants, planVideoVariants } from '../src/modules/media/plans';
import { api, drainJobs, errorCode, relogin, signupUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { fetchSigned, makeImage, makeVideo, MIME, probeBuffer, uploadMedia } from './helpers/media';

describe('media pipeline', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { MEDIA_MAX_VIDEO_SECONDS: '5' } });
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  describe('video', () => {
    it('uploads, processes and serves a vertical video end-to-end', async () => {
      const u = await signupUser(t);
      const bytes = await makeVideo({ width: 540, height: 960, seconds: 2 });
      const { media } = await uploadMedia(t, u, bytes, { kind: 'VIDEO', mime: MIME.mp4 });

      expect(media.status).toBe('READY');
      expect(media).toMatchObject({
        kind: 'VIDEO',
        width: 540,
        height: 960,
        hasAudio: true,
        failureCode: null,
      });
      expect(media.aspectRatio).toBeCloseTo(0.5625, 3);
      expect(media.durationMs).toBeGreaterThan(1800);
      expect(media.durationMs).toBeLessThan(2400);
      for (const k of ['playback', 'playbackLow', 'poster', 'thumbnail'])
        expect(media.urls[k]).toMatch(/^http/);
      expect(media.urls.large).toBeNull();

      const playback = await fetchSigned(t, media.urls.playback);
      expect(playback.statusCode).toBe(200);
      expect(playback.headers['content-type']).toBe('video/mp4');
      expect(playback.rawPayload.subarray(4, 8).toString()).toBe('ftyp');
      expect(playback.headers['accept-ranges']).toBe('bytes');
      const probed = await probeBuffer(playback.rawPayload);
      expect(probed.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);

      const poster = await fetchSigned(t, media.urls.poster);
      expect(poster.headers['content-type']).toBe('image/jpeg');
      expect(poster.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    }, 60_000);

    it('supports HTTP Range requests for seeking', async () => {
      const u = await signupUser(t);
      const { media } = await uploadMedia(t, u, await makeVideo({ seconds: 1 }), {
        kind: 'VIDEO',
        mime: MIME.mp4,
      });
      const full = await fetchSigned(t, media.urls.playback);
      const size = full.rawPayload.length;

      const part = await fetchSigned(t, media.urls.playback, { range: 'bytes=0-99' });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 0-99/${size}`);
      expect(part.rawPayload).toHaveLength(100);
      expect(part.rawPayload.equals(full.rawPayload.subarray(0, 100))).toBe(true);

      const tail = await fetchSigned(t, media.urls.playback, { range: 'bytes=-50' });
      expect(tail.statusCode).toBe(206);
      expect(tail.rawPayload.equals(full.rawPayload.subarray(size - 50))).toBe(true);
      expect(
        (await fetchSigned(t, media.urls.playback, { range: `bytes=${size + 10}-` })).statusCode,
      ).toBe(416);
    }, 60_000);

    it('downsizes large sources without distorting them, and never upscales small ones', async () => {
      const u = await signupUser(t);
      const big = await uploadMedia(
        t,
        u,
        await makeVideo({ width: 1080, height: 1920, seconds: 1, fps: 15 }),
        { kind: 'VIDEO', mime: MIME.mp4 },
      );
      expect(big.media.status).toBe('READY');
      expect(big.media.width).toBe(720);
      expect(big.media.height).toBe(1280);
      const low = await probeBuffer((await fetchSigned(t, big.media.urls.playbackLow)).rawPayload);
      const lowStream = low.streams.find((s) => s.codec_type === 'video');
      expect([lowStream?.width, lowStream?.height]).toEqual([360, 640]);

      const land = await uploadMedia(
        t,
        u,
        await makeVideo({ width: 1920, height: 1080, seconds: 1, fps: 15 }),
        { kind: 'VIDEO', mime: MIME.mp4 },
      );
      expect([land.media.width, land.media.height]).toEqual([1280, 720]);

      const small = await uploadMedia(
        t,
        u,
        await makeVideo({ width: 320, height: 568, seconds: 1 }),
        { kind: 'VIDEO', mime: MIME.mp4 },
      );
      expect([small.media.width, small.media.height]).toEqual([320, 568]); // not enlarged
    }, 120_000);

    it('handles videos with no audio track', async () => {
      const u = await signupUser(t);
      const { media } = await uploadMedia(t, u, await makeVideo({ audio: false, seconds: 1 }), {
        kind: 'VIDEO',
        mime: MIME.mp4,
      });
      expect(media.status).toBe('READY');
      expect(media.hasAudio).toBe(false);
    }, 60_000);

    it('accepts MOV and WebM containers', async () => {
      const u = await signupUser(t);
      const mov = await uploadMedia(t, u, await makeVideo({ container: 'mov', seconds: 1 }), {
        kind: 'VIDEO',
        mime: MIME.mov,
      });
      expect(mov.media.status).toBe('READY');
      const webm = await uploadMedia(t, u, await makeVideo({ container: 'webm', seconds: 1 }), {
        kind: 'VIDEO',
        mime: MIME.webm,
      });
      expect(webm.media.status).toBe('READY');
    }, 120_000);

    it('strips location and device metadata from every output', async () => {
      const u = await signupUser(t);
      const withGps = await makeVideo({
        seconds: 1,
        metadata: {
          location: '+44.0521-123.0868/',
          title: 'home-run-secret',
          comment: 'secret-comment',
        },
      });
      const input = await probeBuffer(withGps);
      expect(JSON.stringify(input.format.tags)).toContain('44.0521'); // sanity: the fixture really carries GPS
      const { media } = await uploadMedia(t, u, withGps, { kind: 'VIDEO', mime: MIME.mp4 });
      for (const url of [media.urls.playback, media.urls.playbackLow]) {
        const out = await probeBuffer((await fetchSigned(t, url)).rawPayload);
        const tags =
          JSON.stringify(out.format.tags ?? {}) +
          JSON.stringify(out.streams.map((s) => s.tags ?? {}));
        expect(tags).not.toContain('44.0521');
        expect(tags).not.toContain('secret');
      }
      const poster = (await fetchSigned(t, media.urls.poster)).rawPayload;
      expect(poster.toString('latin1')).not.toContain('44.0521');
    }, 60_000);

    it('never serves the original upload, even with a validly signed URL', async () => {
      const u = await signupUser(t);
      const { id } = await uploadMedia(t, u, await makeVideo({ seconds: 1 }), {
        kind: 'VIDEO',
        mime: MIME.mp4,
      });
      const row = await t.platform.db
        .selectFrom('mediaAssets')
        .select('storageKey')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const url = await t.services.storage.signedReadUrl(
        row.storageKey,
        new Date(t.clock.now().getTime() + 60_000),
      );
      expect((await fetchSigned(t, url)).statusCode).toBe(404);
    }, 60_000);
  });

  describe('rejections', () => {
    const reject = async (bytes: Buffer, o: { kind: 'VIDEO' | 'IMAGE'; mime: string }) => {
      const u = await signupUser(t);
      const res = await uploadMedia(t, u, bytes, o);
      return { ...res, user: u };
    };

    it('rejects a text file posing as a video, and deletes the stored original', async () => {
      const { id, media } = await reject(
        Buffer.from('this is definitely not a video file'.repeat(20)),
        { kind: 'VIDEO', mime: MIME.mp4 },
      );
      expect(media).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_MEDIA' });
      expect(media.urls.playback).toBeNull();
      await drainJobs(t); // runs the queued delete-objects job
      const row = await t.platform.db
        .selectFrom('mediaAssets')
        .select('storageKey')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(await t.services.storage.head(row.storageKey)).toBeNull();
    });

    it('rejects an image uploaded as a video, and a video uploaded as an image', async () => {
      const img = await makeImage({ format: 'jpg' });
      expect((await reject(img, { kind: 'VIDEO', mime: MIME.mp4 })).media.status).toBe('REJECTED');
      const vid = await makeVideo({ seconds: 1 });
      expect((await reject(vid, { kind: 'IMAGE', mime: MIME.jpg })).media.failureCode).toBe(
        'UNSUPPORTED_FORMAT',
      );
    }, 60_000);

    it('rejects videos longer than the limit', async () => {
      const { media } = await reject(
        await makeVideo({ seconds: 7, width: 160, height: 284, fps: 10 }),
        { kind: 'VIDEO', mime: MIME.mp4 },
      );
      expect(media).toMatchObject({ status: 'REJECTED', failureCode: 'TOO_LONG' });
    }, 60_000);

    it('rejects tiny and unsupported-container videos', async () => {
      expect(
        (
          await reject(await makeVideo({ width: 32, height: 32, seconds: 1 }), {
            kind: 'VIDEO',
            mime: MIME.mp4,
          })
        ).media.failureCode,
      ).toBe('TOO_SMALL');
      expect(
        (
          await reject(await makeVideo({ container: 'avi', seconds: 1, width: 320, height: 240 }), {
            kind: 'VIDEO',
            mime: MIME.mp4,
          })
        ).media.failureCode,
      ).toBe('UNSUPPORTED_FORMAT');
    }, 60_000);

    it('rejects animated GIFs and truncated files', async () => {
      expect(
        (await reject(await makeImage({ format: 'gif' }), { kind: 'IMAGE', mime: MIME.png })).media
          .status,
      ).toBe('REJECTED');
      const full = await makeVideo({ seconds: 2 });
      const truncated = full.subarray(0, Math.floor(full.length / 3));
      expect((await reject(truncated, { kind: 'VIDEO', mime: MIME.mp4 })).media.status).toBe(
        'REJECTED',
      );
    }, 60_000);

    it('a moderation BLOCK verdict rejects the media and leaves no variants behind', async () => {
      const blocked = await createTestApp({});
      try {
        class Blocker extends AllowAllModerator {
          override async moderateImage() {
            return { verdict: 'BLOCK' as const, reason: 'test block' };
          }
        }
        const { createServices } = await import('../src/services');
        const { buildApp } = await import('../src/app');
        const services = createServices(blocked.platform, { moderator: new Blocker() });
        const app = await buildApp(blocked.platform, services);
        await app.ready();
        const t2: TestApp = { ...blocked, app, services };
        const u = await signupUser(t2);
        const res = await uploadMedia(t2, u, await makeImage({ format: 'jpg' }), {
          kind: 'IMAGE',
          mime: MIME.jpg,
        });
        expect(res.media).toMatchObject({ status: 'REJECTED', failureCode: 'MODERATION_REJECTED' });
        const variants = await blocked.platform.db
          .selectFrom('mediaVariants')
          .select('id')
          .where('mediaId', '=', res.id)
          .execute();
        expect(variants).toEqual([]);
        await app.close();
      } finally {
        await blocked.close();
      }
    }, 60_000);
  });

  describe('images', () => {
    it('produces large/medium/thumbnail JPEGs, strips metadata, and never upscales', async () => {
      const u = await signupUser(t);
      const { media } = await uploadMedia(
        t,
        u,
        await makeImage({ width: 3000, height: 2000, format: 'jpg' }),
        { kind: 'IMAGE', mime: MIME.jpg },
      );
      expect(media.status).toBe('READY');
      expect([media.width, media.height]).toEqual([2048, 1366]);
      expect(media.urls.playback).toBeNull();
      const dims = async (url: string) => {
        const p = await probeBuffer((await fetchSigned(t, url)).rawPayload);
        return [p.streams[0]?.width, p.streams[0]?.height];
      };
      expect(await dims(media.urls.medium)).toEqual([1080, 720]);
      expect(await dims(media.urls.thumbnail)).toEqual([480, 320]);

      const small = await uploadMedia(
        t,
        u,
        await makeImage({ width: 200, height: 200, format: 'png' }),
        { kind: 'IMAGE', mime: MIME.png },
      );
      expect([small.media.width, small.media.height]).toEqual([200, 200]);
      const webp = await uploadMedia(
        t,
        u,
        await makeImage({ width: 640, height: 480, format: 'webp' }),
        { kind: 'IMAGE', mime: MIME.webp },
      );
      expect(webp.media.status).toBe('READY');
    }, 120_000);

    it('avatars are square centre-crops and can be set, replaced and removed', async () => {
      const u = await signupUser(t);
      const first = await uploadMedia(
        t,
        u,
        await makeImage({ width: 1200, height: 800, format: 'jpg' }),
        { kind: 'IMAGE', mime: MIME.jpg, purpose: 'AVATAR' },
      );
      expect([first.media.width, first.media.height]).toEqual([800, 800]);

      const set = await api(t, u).put('/me/avatar', { mediaId: first.id });
      expect(set.statusCode).toBe(200);
      expect(set.json().avatar.thumbUrl).toMatch(/^http/);
      const thumb = await probeBuffer(
        (await fetchSigned(t, set.json().avatar.thumbUrl)).rawPayload,
      );
      expect([thumb.streams[0]?.width, thumb.streams[0]?.height]).toEqual([480, 480]);
      // The avatar shows up wherever the user does.
      const other = await signupUser(t);
      expect((await api(t, other).get(`/users/${u.id}`)).json().avatar.mediumUrl).toMatch(/^http/);

      const second = await uploadMedia(
        t,
        u,
        await makeImage({ width: 600, height: 600, format: 'png' }),
        { kind: 'IMAGE', mime: MIME.png, purpose: 'AVATAR' },
      );
      expect((await api(t, u).put('/me/avatar', { mediaId: second.id })).statusCode).toBe(200);
      expect((await api(t, u).get(`/media/${first.id}`)).statusCode).toBe(404); // old avatar reclaimed

      expect((await api(t, u).del('/me/avatar')).json().avatar).toBeNull();
    }, 120_000);

    it("refuses to use someone else's, non-avatar, or unfinished media as an avatar", async () => {
      const u = await signupUser(t);
      const other = await signupUser(t);
      const post = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
        purpose: 'POST',
      });
      expect(errorCode(await api(t, u).put('/me/avatar', { mediaId: post.id }))).toBe(
        'VALIDATION_FAILED',
      );
      const theirs = await uploadMedia(t, other, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
        purpose: 'AVATAR',
      });
      expect(errorCode(await api(t, u).put('/me/avatar', { mediaId: theirs.id }))).toBe(
        'MEDIA_NOT_FOUND',
      );
      const pending = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
        purpose: 'AVATAR',
        process: false,
      });
      expect(errorCode(await api(t, u).put('/me/avatar', { mediaId: pending.id }))).toBe(
        'MEDIA_NOT_READY',
      );
    }, 60_000);
  });

  describe('upload initiation and completion', () => {
    it('validates declared type, size and purpose up front', async () => {
      const u = await signupUser(t);
      const init = (body: Record<string, unknown>) => api(t, u).post('/media/uploads', body);
      expect(
        errorCode(await init({ kind: 'VIDEO', mimeType: 'application/pdf', sizeBytes: 1000 })),
      ).toBe('UNSUPPORTED_FILE');
      expect(errorCode(await init({ kind: 'IMAGE', mimeType: 'video/mp4', sizeBytes: 1000 }))).toBe(
        'UNSUPPORTED_FILE',
      );
      expect(
        errorCode(
          await init({
            kind: 'VIDEO',
            mimeType: 'video/mp4',
            sizeBytes: t.config.MEDIA_MAX_VIDEO_BYTES + 1,
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        errorCode(
          await init({ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1000, purpose: 'AVATAR' }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(errorCode(await init({ kind: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: 0 }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(
        (
          await api(t).post('/media/uploads', {
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            sizeBytes: 5,
          })
        ).statusCode,
      ).toBe(401);
      const limits = (await api(t, u).get('/media/limits')).json();
      expect(limits.allowedVideoMimeTypes).toContain('video/mp4');
    });

    it('caps unfinished upload slots per user', async () => {
      const u = await signupUser(t);
      for (let i = 0; i < 20; i++)
        expect(
          (
            await api(t, u).post('/media/uploads', {
              kind: 'IMAGE',
              mimeType: 'image/jpeg',
              sizeBytes: 100,
            })
          ).statusCode,
        ).toBe(201);
      expect(
        errorCode(
          await api(t, u).post('/media/uploads', {
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            sizeBytes: 100,
          }),
        ),
      ).toBe('RATE_LIMITED');
    });

    it('complete fails until the file is actually uploaded, and is idempotent afterwards', async () => {
      const u = await signupUser(t);
      const bytes = await makeImage({ format: 'jpg' });
      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: bytes.length,
        })
      ).json();
      expect(errorCode(await api(t, u).post(`/media/${init.media.id}/complete`))).toBe(
        'UPLOAD_INCOMPLETE',
      );
      expect(init.media.status).toBe('PENDING_UPLOAD');

      const url = new URL(init.upload.url as string);
      await t.app.inject({
        method: 'PUT',
        url: `${url.pathname}${url.search}`,
        headers: { 'content-type': 'image/jpeg' },
        payload: bytes,
      });
      const a = await api(t, u).post(`/media/${init.media.id}/complete`);
      const b = await api(t, u).post(`/media/${init.media.id}/complete`);
      expect(a.json().status).toBe('UPLOADED');
      expect(b.statusCode).toBe(200);
      const jobs = await t.platform.db
        .selectFrom('jobs')
        .select('id')
        .where('name', '=', 'media.process')
        .where('payload', '@>', JSON.stringify({ mediaId: init.media.id }) as never)
        .execute();
      expect(jobs).toHaveLength(1); // not queued twice
    });

    it('rejects uploads that disagree with what was authorised (wrong type, wrong length, tampered URL)', async () => {
      const u = await signupUser(t);
      const bytes = await makeImage({ format: 'jpg' });
      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: bytes.length,
        })
      ).json();
      const url = new URL(init.upload.url as string);
      const put = (path: string, headers: Record<string, string>, payload: Buffer) =>
        t.app.inject({ method: 'PUT', url: path, headers, payload });
      const base = `${url.pathname}${url.search}`;

      expect((await put(base, { 'content-type': 'video/mp4' }, bytes)).statusCode).toBe(403); // wrong content type
      expect(
        (
          await put(
            base,
            { 'content-type': 'image/jpeg' },
            Buffer.concat([bytes, Buffer.from('x')]),
          )
        ).statusCode,
      ).toBe(403); // longer than signed
      expect(
        (await put(base, { 'content-type': 'image/jpeg' }, bytes.subarray(0, bytes.length - 1)))
          .statusCode,
      ).toBe(403); // shorter
      expect(
        (
          await put(
            base.replace(/sig=[^&]+/, 'sig=' + 'A'.repeat(43)),
            { 'content-type': 'image/jpeg' },
            bytes,
          )
        ).statusCode,
      ).toBe(403); // forged sig
      expect(
        (
          await put(
            base.replace(/key=[^&]+/, 'key=' + encodeURIComponent('media/x/y/original')),
            { 'content-type': 'image/jpeg' },
            bytes,
          )
        ).statusCode,
      ).toBe(403); // different key
      t.clock.advanceSeconds(t.config.UPLOAD_URL_TTL_SECONDS + 5);
      expect((await put(base, { 'content-type': 'image/jpeg' }, bytes)).statusCode).toBe(403); // expired
      t.clock.advanceSeconds(-(t.config.UPLOAD_URL_TTL_SECONDS + 5));
      expect((await put(base, { 'content-type': 'image/jpeg' }, bytes)).statusCode).toBe(200); // the genuine request still works
    });

    it('complete detects a stored object whose size differs from the declaration and deletes it', async () => {
      const u = await signupUser(t);
      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
        })
      ).json();
      const row = await t.platform.db
        .selectFrom('mediaAssets')
        .select('storageKey')
        .where('id', '=', init.media.id)
        .executeTakeFirstOrThrow();
      const tmp = path.join(t.config.LOCAL_STORAGE_DIR, '..', `lie-${Date.now()}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(tmp, Buffer.alloc(999));
      await t.services.storage.uploadFile(row.storageKey, tmp, 'image/jpeg');
      expect(errorCode(await api(t, u).post(`/media/${init.media.id}/complete`))).toBe(
        'UPLOAD_INCOMPLETE',
      );
      expect(await t.services.storage.head(row.storageKey)).toBeNull();
    });
  });

  describe('authorisation', () => {
    it('media is private to its owner', async () => {
      const owner = await signupUser(t);
      const other = await signupUser(t);
      const { id } = await uploadMedia(t, owner, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      expect(errorCode(await api(t, other).get(`/media/${id}`))).toBe('MEDIA_NOT_FOUND');
      expect(errorCode(await api(t, other).post(`/media/${id}/complete`))).toBe('MEDIA_NOT_FOUND');
      expect(errorCode(await api(t, other).del(`/media/${id}`))).toBe('MEDIA_NOT_FOUND');
      expect(errorCode(await api(t, other).post(`/media/${id}/retry`))).toBe('MEDIA_NOT_FOUND');
    }, 30_000);
  });

  describe('state machine (database-enforced)', () => {
    async function pendingRow() {
      const u = await signupUser(t);
      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'VIDEO',
          mimeType: 'video/mp4',
          sizeBytes: 5000,
        })
      ).json();
      return { user: u, id: init.media.id as string };
    }

    it('an upload that was never processed cannot be marked READY, however it is attempted', async () => {
      const { id } = await pendingRow();
      const update = (status: string) =>
        t.platform.db
          .updateTable('mediaAssets')
          .set({
            status: status as never,
            readyAt: new Date(),
            actualSizeBytes: 5000,
            moderationStatus: 'APPROVED',
          })
          .where('id', '=', id)
          .execute();
      await expect(update('READY')).rejects.toThrow(
        /illegal media status transition PENDING_UPLOAD -> READY/,
      );
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'UPLOADED' })
        .where('id', '=', id)
        .execute();
      await expect(update('READY')).rejects.toThrow(
        /illegal media status transition UPLOADED -> READY/,
      );
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'PROCESSING' })
        .where('id', '=', id)
        .execute();
      // Legal transition, but no metadata/variants exist: still refused.
      await expect(update('READY')).rejects.toThrow(
        /cannot be READY without metadata and variants/,
      );
      const row = await t.platform.db
        .selectFrom('mediaAssets')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PROCESSING');
    });

    it('terminal states stay terminal and READY needs moderation approval', async () => {
      const { id } = await pendingRow();
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'UPLOADED' })
        .where('id', '=', id)
        .execute();
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'REJECTED', failureCode: 'INVALID_MEDIA' })
        .where('id', '=', id)
        .execute();
      await expect(
        t.platform.db
          .updateTable('mediaAssets')
          .set({ status: 'PROCESSING' })
          .where('id', '=', id)
          .execute(),
      ).rejects.toThrow(/illegal media status transition REJECTED/);
      // failure_code is required with FAILED/REJECTED and forbidden otherwise.
      const two = await pendingRow();
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'UPLOADED' })
        .where('id', '=', two.id)
        .execute();
      await expect(
        t.platform.db
          .updateTable('mediaAssets')
          .set({ status: 'FAILED' })
          .where('id', '=', two.id)
          .execute(),
      ).rejects.toThrow(/media_failure_pairing/);
    });
  });

  describe('signed URLs', () => {
    it('are tamper-proof and expire', async () => {
      const u = await signupUser(t);
      const { media } = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      const url = media.urls.medium as string;
      expect((await fetchSigned(t, url)).statusCode).toBe(200);
      expect(
        (await fetchSigned(t, url.replace(/sig=[^&]+/, 'sig=' + 'B'.repeat(43)))).statusCode,
      ).toBe(403);
      expect(
        (
          await fetchSigned(
            t,
            url.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) + 9_999_999}`),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await fetchSigned(t, url.replace('image-medium.jpg', 'image-large.jpg'))).statusCode,
      ).toBe(403); // sig is bound to the key
      t.clock.advanceSeconds(t.config.MEDIA_URL_TTL_SECONDS + 10);
      expect((await fetchSigned(t, url)).statusCode).toBe(403);
      t.clock.advanceSeconds(-(t.config.MEDIA_URL_TTL_SECONDS + 10));
    }, 30_000);

    it('stay stable within a time bucket so client caches keep working', async () => {
      const u = await signupUser(t);
      const { id } = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      const a = (await api(t, u).get(`/media/${id}`)).json().urls.medium;
      t.clock.advanceSeconds(60);
      const b = (await api(t, u).get(`/media/${id}`)).json().urls.medium;
      expect(b).toBe(a);
      t.clock.advanceSeconds(t.config.MEDIA_URL_TTL_SECONDS);
      const c = (await api(t, await relogin(t, u)).get(`/media/${id}`)).json().urls.medium;
      expect(c).not.toBe(a);
    }, 30_000);
  });

  describe('failure handling and housekeeping', () => {
    it('infrastructure failures retry, then end as a visible FAILED/PROCESSING_ERROR (never stuck PROCESSING)', async () => {
      const broken = await createTestApp({ env: { FFPROBE_PATH: '/nonexistent/ffprobe' } });
      try {
        const u = await signupUser(broken);
        const bytes = await makeImage({ format: 'jpg' });
        const res = await uploadMedia(broken, u, bytes, {
          kind: 'IMAGE',
          mime: MIME.jpg,
          process: false,
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          await drainJobs(broken);
          broken.clock.advanceSeconds(3600);
        }
        const u2 = await relogin(broken, u); // the clock moved past the access-token lifetime
        const media = (await api(broken, u2).get(`/media/${res.id}`)).json();
        expect(media).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_ERROR' });
        const changed = await broken.platform.db
          .selectFrom('jobs')
          .select('payload')
          .where('name', '=', 'media.status_changed')
          .execute();
        expect(changed.some((j) => (j.payload as { status: string }).status === 'FAILED')).toBe(
          true,
        );

        // Retry is allowed for FAILED media, and moves it back into processing.
        const retried = await api(broken, u2).post(`/media/${res.id}/retry`);
        expect(retried.json().status).toBe('PROCESSING');
      } finally {
        await broken.close();
      }
    }, 60_000);

    it('retry works end-to-end once the underlying problem is gone', async () => {
      const u = await signupUser(t);
      const res = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
        process: false,
      });
      // Simulate a transient failure that already happened.
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'PROCESSING' })
        .where('id', '=', res.id)
        .execute();
      await t.platform.db
        .updateTable('mediaAssets')
        .set({ status: 'FAILED', failureCode: 'PROCESSING_ERROR' })
        .where('id', '=', res.id)
        .execute();
      await t.platform.db.deleteFrom('jobs').where('name', '=', 'media.process').execute();
      expect(
        errorCode(
          await api(t, u).post(
            `/media/${res.id}/retry`.replace(res.id, '018f0000-0000-7000-8000-000000000000'),
          ),
        ),
      ).toBe('MEDIA_NOT_FOUND');
      expect((await api(t, u).post(`/media/${res.id}/retry`)).json().status).toBe('PROCESSING');
      await drainJobs(t);
      expect((await api(t, u).get(`/media/${res.id}`)).json()).toMatchObject({
        status: 'READY',
        failureCode: null,
      });
    }, 60_000);

    it('only FAILED media can be retried', async () => {
      const u = await signupUser(t);
      const res = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      expect(errorCode(await api(t, u).post(`/media/${res.id}/retry`))).toBe('INVALID_STATE');
    }, 30_000);

    it('deleting media removes its row and, via a queued job, every stored object', async () => {
      const u = await signupUser(t);
      const { id, media } = await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      const keys = (
        await t.platform.db
          .selectFrom('mediaVariants')
          .select('storageKey')
          .where('mediaId', '=', id)
          .execute()
      ).map((v) => v.storageKey);
      expect(keys.length).toBe(3);
      expect((await api(t, u).del(`/media/${id}`)).statusCode).toBe(204);
      expect((await api(t, u).get(`/media/${id}`)).statusCode).toBe(404);
      await drainJobs(t);
      for (const key of keys) expect(await t.services.storage.head(key)).toBeNull();
      expect((await fetchSigned(t, media.urls.medium)).statusCode).toBe(404);
    }, 30_000);

    it('cleanup removes abandoned upload slots after the grace period', async () => {
      const u = await signupUser(t);
      const init = (
        await api(t, u).post('/media/uploads', {
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
        })
      ).json();
      await t.services.media.handleCleanup();
      expect((await api(t, u).get(`/media/${init.media.id}`)).statusCode).toBe(200); // still within its window
      t.clock.advanceSeconds(t.config.UPLOAD_URL_TTL_SECONDS + 3 * 3600);
      await t.services.media.handleCleanup();
      expect((await api(t, await relogin(t, u)).get(`/media/${init.media.id}`)).statusCode).toBe(
        404,
      );
      t.clock.advanceSeconds(-(t.config.UPLOAD_URL_TTL_SECONDS + 3 * 3600));
    });

    it('leaves no temp files behind after processing', async () => {
      const before = (await readdir(os.tmpdir())).filter((f) =>
        f.startsWith('runningapp-media-'),
      ).length;
      const u = await signupUser(t);
      await uploadMedia(t, u, await makeImage({ format: 'jpg' }), {
        kind: 'IMAGE',
        mime: MIME.jpg,
      });
      await uploadMedia(t, u, Buffer.from('garbage'.repeat(50)), { kind: 'VIDEO', mime: MIME.mp4 });
      const after = (await readdir(os.tmpdir())).filter((f) =>
        f.startsWith('runningapp-media-'),
      ).length;
      expect(after).toBe(before);
    }, 30_000);
  });

  describe('safety nets', () => {
    it('storage keys are validated against traversal and odd shapes', () => {
      for (const bad of [
        '../etc/passwd',
        'media/../x',
        '/abs/path',
        'a',
        'media//x',
        'media/a b/c',
        'media/x/..',
        'media/x/y\\z',
        'media/x/y\u0000z',
        '',
        'x'.repeat(400),
      ]) {
        expect(() => assertSafeKey(bad), JSON.stringify(bad)).toThrow();
      }
      expect(() =>
        assertSafeKey(
          'media/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001/video-high.mp4',
        ),
      ).not.toThrow();
    });

    it('every ffmpeg plan strips metadata and never enlarges', () => {
      const plans = [
        ...planVideoVariants({ width: 1080, height: 1920, durationS: 10, fps: 60, hasAudio: true }),
        ...planVideoVariants({
          width: 640,
          height: 480,
          durationS: 0.5,
          fps: undefined,
          hasAudio: false,
        }),
        ...planImageVariants({ width: 4000, height: 3000, avatar: false }),
        ...planImageVariants({ width: 100, height: 100, avatar: true }),
      ];
      for (const p of plans) {
        const args = p.args('in', 'out').join(' ');
        expect(args, p.name).toContain('-map_metadata -1');
        expect(args, p.name).toContain('min(');
        expect(args, p.name).toContain('force_original_aspect_ratio=decrease');
        expect(args, p.name).toContain('force_divisible_by=2');
      }
      const v = planVideoVariants({
        width: 1080,
        height: 1920,
        durationS: 0.5,
        fps: 60,
        hasAudio: false,
      });
      expect(
        v
          .find((p) => p.name === 'video-high.mp4')
          ?.args('i', 'o')
          .join(' '),
      ).toContain('fps=30'); // caps frame rate
      expect(v.find((p) => p.name === 'video-high.mp4')?.args('i', 'o')).toContain('-an'); // silent source: no audio map
      expect(v.find((p) => p.name === 'poster.jpg')?.args('i', 'o')[1]).toBe('0.25'); // seeks inside a very short clip
    });
  });
});
