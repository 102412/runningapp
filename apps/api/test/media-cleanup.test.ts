import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, drainJobs, signupUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { MIME, uploadMedia } from './helpers/media';
import { createPost, readyImage, sampleImage } from './helpers/posts';

const DAY = 86_400;

describe('orphaned media cleanup', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const keysOf = async (mediaId: string) => {
    const asset = await t.platform.db
      .selectFrom('mediaAssets')
      .select('storageKey')
      .where('id', '=', mediaId)
      .executeTakeFirstOrThrow();
    const variants = await t.platform.db
      .selectFrom('mediaVariants')
      .select('storageKey')
      .where('mediaId', '=', mediaId)
      .execute();
    return [asset.storageKey, ...variants.map((v) => v.storageKey)];
  };

  it('deletes unattached media (and its files) after the retention window, and nothing else', async () => {
    const user = await signupUser(t);
    const orphan = await readyImage(t, user);
    const attached = await readyImage(t, user);
    const avatar = (
      await uploadMedia(t, user, await sampleImage(), {
        kind: 'IMAGE',
        mime: MIME.jpg,
        purpose: 'AVATAR',
      })
    ).id;
    const recent = await readyImage(t, user);
    await createPost(t, user, {
      caption: 'with a photo',
      visibility: 'PUBLIC',
      mediaIds: [attached],
    });
    expect((await api(t, user).put('/me/avatar', { mediaId: avatar })).statusCode).toBe(200);

    const orphanKeys = await keysOf(orphan);
    const keptKeys = [
      ...(await keysOf(attached)),
      ...(await keysOf(avatar)),
      ...(await keysOf(recent)),
    ];
    expect(orphanKeys.length).toBeGreaterThan(1); // original + variants
    for (const key of [...orphanKeys, ...keptKeys])
      expect(await t.services.storage.head(key), key).not.toBeNull();

    // Age everything except `recent` past the window.
    const old = new Date(
      t.clock.now().getTime() - (t.config.MEDIA_ORPHAN_RETENTION_DAYS + 1) * DAY * 1000,
    );
    await t.platform.db
      .updateTable('mediaAssets')
      .set({ createdAt: old })
      .where('id', 'in', [orphan, attached, avatar])
      .execute();

    await t.services.media.handleCleanup();
    await drainJobs(t);

    const left = (await t.platform.db.selectFrom('mediaAssets').select('id').execute())
      .map((m) => m.id)
      .sort();
    expect(left).toEqual([attached, avatar, recent].sort());
    for (const key of orphanKeys)
      expect(await t.services.storage.head(key), `${key} should be gone`).toBeNull();
    for (const key of keptKeys)
      expect(await t.services.storage.head(key), `${key} should stay`).not.toBeNull();

    // Idempotent: a second run changes nothing.
    await t.services.media.handleCleanup();
    expect(await t.platform.db.selectFrom('mediaAssets').select('id').execute()).toHaveLength(3);
  });
});
