import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { hmacSha256, safeEqual } from '../crypto/tokens';
import type { Clock } from '../clock';
import {
  assertSafeKey,
  contentTypeForKey,
  type ObjectStorage,
  type StoredObjectInfo,
  type UploadTarget,
} from './types';

export class StorageSignatureError extends Error {}

/**
 * Disk-backed storage for development and tests. It honours the same contract as S3: uploads go
 * to a time-limited signed URL whose signature covers the key, content type and exact length;
 * reads go through signed, expiring URLs. The API serves both (see modules/media/storage-routes).
 */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly clock: Clock,
  ) {
    this.root = path.resolve(rootDir);
  }

  // ---- URL signing ----------------------------------------------------------------------------

  private uploadSignature(
    key: string,
    contentType: string,
    contentLength: number,
    exp: number,
  ): string {
    return hmacSha256(this.secret, `PUT\n${key}\n${contentType}\n${contentLength}\n${exp}`);
  }

  private readSignature(key: string, exp: number): string {
    return hmacSha256(this.secret, `GET\n${key}\n${exp}`);
  }

  async createUpload(
    key: string,
    o: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<UploadTarget> {
    assertSafeKey(key);
    const expiresAt = new Date(this.clock.now().getTime() + o.expiresInSeconds * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = this.uploadSignature(key, o.contentType, o.contentLength, exp);
    const url = `${this.publicBaseUrl}/v1/storage/upload?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': o.contentType, 'Content-Length': String(o.contentLength) },
      expiresAt,
    };
  }

  async signedReadUrl(key: string, expiresAt: Date): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return `${this.publicBaseUrl}/v1/storage/files/${key}?exp=${exp}&sig=${this.readSignature(key, exp)}`;
  }

  /** Validates an upload request's signature, expiry and declared headers. */
  verifyUpload(
    params: { key: string; exp: number; sig: string },
    headers: { contentType: string | undefined; contentLength: number | undefined },
  ): void {
    assertSafeKey(params.key);
    if (params.exp * 1000 < this.clock.now().getTime())
      throw new StorageSignatureError('Upload URL expired');
    if (headers.contentType === undefined || headers.contentLength === undefined) {
      throw new StorageSignatureError('Content-Type and Content-Length are required');
    }
    const expected = this.uploadSignature(
      params.key,
      headers.contentType,
      headers.contentLength,
      params.exp,
    );
    if (!safeEqual(expected, params.sig)) throw new StorageSignatureError('Bad signature');
  }

  verifyRead(params: { key: string; exp: number; sig: string }): void {
    assertSafeKey(params.key);
    if (params.exp * 1000 < this.clock.now().getTime())
      throw new StorageSignatureError('URL expired');
    if (!safeEqual(this.readSignature(params.key, params.exp), params.sig))
      throw new StorageSignatureError('Bad signature');
  }

  // ---- object operations ----------------------------------------------------------------------

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Path escapes storage root');
    return full;
  }

  /** Streams an upload to disk, aborting (and cleaning up) if more than `expectedLength` bytes arrive. */
  async writeStream(key: string, body: Readable, expectedLength: number): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expectedLength)
          cb(new StorageSignatureError('Body exceeds declared Content-Length'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(tmp));
      if (received !== expectedLength)
        throw new StorageSignatureError('Body shorter than declared Content-Length');
      await rename(tmp, dest);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const s = await stat(this.resolve(key));
      return { sizeBytes: s.size, contentType: contentTypeForKey(key) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    await copyFile(this.resolve(key), destinationPath);
  }

  async uploadFile(key: string, sourcePath: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(sourcePath, dest);
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  /** For the file-serving route. */
  async openForRead(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ size: number; stream: Readable; contentType: string }> {
    const full = this.resolve(key);
    const s = await stat(full);
    return {
      size: s.size,
      stream: createReadStream(full, range ? { start: range.start, end: range.end } : undefined),
      contentType: contentTypeForKey(key),
    };
  }
}
