import { api, type TestUser } from './api';
import type { TestApp } from './app';
import { makeImage, makeVideo, MIME, uploadMedia } from './media';

let videoBytes: Promise<Buffer> | undefined;
let imageBytes: Promise<Buffer> | undefined;

/** Tiny reusable fixtures (generated once per test file process). */
export const sampleVideo = (): Promise<Buffer> =>
  (videoBytes ??= makeVideo({ width: 320, height: 568, seconds: 1, fps: 15 }));
export const sampleImage = (): Promise<Buffer> =>
  (imageBytes ??= makeImage({ width: 640, height: 480, format: 'jpg' }));

/** Uploads + processes a video and returns its media id (status READY). */
export async function readyVideo(t: TestApp, user: TestUser): Promise<string> {
  const { id, media } = await uploadMedia(t, user, await sampleVideo(), {
    kind: 'VIDEO',
    mime: MIME.mp4,
  });
  if (media.status !== 'READY') throw new Error(`video not ready: ${JSON.stringify(media)}`);
  return id;
}

export async function readyImage(t: TestApp, user: TestUser): Promise<string> {
  const { id, media } = await uploadMedia(t, user, await sampleImage(), {
    kind: 'IMAGE',
    mime: MIME.jpg,
  });
  if (media.status !== 'READY') throw new Error(`image not ready: ${JSON.stringify(media)}`);
  return id;
}

/** Uploads a video but does NOT process it (status UPLOADED). */
export async function unprocessedVideo(t: TestApp, user: TestUser): Promise<string> {
  const { id } = await uploadMedia(t, user, await sampleVideo(), {
    kind: 'VIDEO',
    mime: MIME.mp4,
    process: false,
  });
  return id;
}

export async function createPost(
  t: TestApp,
  user: TestUser,
  body: Record<string, unknown> = { caption: 'hello world' },
) {
  const res = await api(t, user).post('/posts', body);
  if (res.statusCode !== 201) throw new Error(`createPost failed ${res.statusCode}: ${res.body}`);
  return res.json();
}

export async function follow(t: TestApp, follower: TestUser, followee: TestUser): Promise<void> {
  await t.platform.db
    .insertInto('follows')
    .values({ followerId: follower.id, followeeId: followee.id })
    .execute();
}
