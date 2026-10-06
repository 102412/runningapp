import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/platform/clock';
import { S3Storage } from '../src/platform/storage/s3';
import { startFakeS3, type FakeS3 } from './helpers/fake-s3';

const KEY =
  'media/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001/original';

describe('S3 storage driver (against a minimal fake S3)', () => {
  let s3: FakeS3;
  let storage: S3Storage;
  let tmp: string;
  const clock = new ManualClock(new Date('2026-06-01T12:00:00Z'));

  beforeAll(async () => {
    s3 = await startFakeS3('test-bucket');
    tmp = await mkdtemp(path.join(os.tmpdir(), 's3test-'));
    storage = new S3Storage(
      {
        bucket: 'test-bucket',
        region: 'us-east-1',
        endpoint: s3.endpoint,
        accessKeyId: 'AKIATESTKEY',
        secretAccessKey: 'test-secret',
        forcePathStyle: true,
      },
      clock,
    );
  });
  afterAll(async () => {
    await s3.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('issues a presigned PUT that signs content-type and content-length, with no stray checksum requirements', async () => {
    const target = await storage.createUpload(KEY, {
      contentType: 'video/mp4',
      contentLength: 1234,
      expiresInSeconds: 900,
    });
    const url = new URL(target.url);
    expect(url.pathname).toBe(`/test-bucket/${KEY}`); // path-style
    const q = url.searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Credential')).toContain('AKIATESTKEY/20260601/us-east-1/s3/aws4_request');
    expect(q.get('X-Amz-Expires')).toBe('900');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    const signed = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['host', 'content-length', 'content-type']));
    // A plain client must be able to PUT with just Content-Type/Length: no checksum params demanded.
    const keys = [...q.keys()].map((k) => k.toLowerCase());
    expect(keys.some((k) => k.includes('checksum'))).toBe(false);
    expect(target.headers).toEqual({ 'Content-Type': 'video/mp4', 'Content-Length': '1234' });
    expect(target.method).toBe('PUT');
    expect(target.expiresAt.toISOString()).toBe('2026-06-01T12:15:00.000Z');

    const res = await fetch(target.url, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: Buffer.alloc(1234, 7),
    });
    expect(res.status).toBe(200);
    expect(s3.objects.get(KEY)?.body).toHaveLength(1234);
  });

  it('head reports size and existence', async () => {
    expect(await storage.head(KEY)).toMatchObject({ sizeBytes: 1234 });
    expect(await storage.head('media/nope/none/original')).toBeNull();
  });

  it('downloads to a file and uploads files with the right content type', async () => {
    const dest = path.join(tmp, 'downloaded');
    await storage.downloadToFile(KEY, dest);
    expect((await readFile(dest)).length).toBe(1234);

    const src = path.join(tmp, 'variant.jpg');
    await writeFile(src, Buffer.from('jpegbytes'));
    const vkey =
      'media/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001/poster.jpg';
    await storage.uploadFile(vkey, src, 'image/jpeg');
    expect(s3.objects.get(vkey)).toMatchObject({ contentType: 'image/jpeg' });
    expect(s3.objects.get(vkey)?.body.toString()).toBe('jpegbytes');
  });

  it('signed read URLs are GET-able, expiring, and stable for a pinned signing date', async () => {
    const signingDate = new Date('2026-06-01T12:00:00Z');
    const expiresAt = new Date('2026-06-01T18:00:00Z');
    const a = await storage.signedReadUrl(KEY, expiresAt, signingDate);
    const b = await storage.signedReadUrl(KEY, expiresAt, signingDate);
    expect(b).toBe(a); // pinned signing date => identical URL => cacheable by clients
    expect(new URL(a).searchParams.get('X-Amz-Expires')).toBe('21600');
    const res = await fetch(a);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1234);
    const later = await storage.signedReadUrl(
      KEY,
      new Date('2026-06-01T21:00:00Z'),
      new Date('2026-06-01T15:00:00Z'),
    );
    expect(later).not.toBe(a);
  });

  it('deletes single and many objects (batching past 1000 keys)', async () => {
    await storage.delete(KEY);
    expect(await storage.head(KEY)).toBeNull();
    const keys = Array.from({ length: 5 }, (_, i) => `media/u/m/file-${i}.jpg`);
    for (const k of keys) s3.objects.set(k, { body: Buffer.from('x'), contentType: undefined });
    await storage.deleteMany(keys);
    for (const k of keys) expect(s3.objects.has(k)).toBe(false);
    const many = Array.from({ length: 1500 }, (_, i) => `media/u/m/bulk-${i}.jpg`);
    for (const k of many) s3.objects.set(k, { body: Buffer.from('x'), contentType: undefined });
    const before = s3.requests.filter((r) => r.method === 'POST').length;
    await storage.deleteMany(many);
    expect(s3.requests.filter((r) => r.method === 'POST').length - before).toBe(2); // 1000 + 500
    expect(many.some((k) => s3.objects.has(k))).toBe(false);
  });

  it('refuses unsafe keys before touching the network', async () => {
    const before = s3.requests.length;
    await expect(
      storage.createUpload('../escape', {
        contentType: 'image/jpeg',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(/Unsafe storage key/);
    await expect(storage.signedReadUrl('media//x', new Date())).rejects.toThrow(
      /Unsafe storage key/,
    );
    expect(s3.requests.length).toBe(before);
  });
});
