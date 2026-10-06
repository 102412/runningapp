import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Clock } from '../clock';
import {
  assertSafeKey,
  type ObjectStorage,
  type StoredObjectInfo,
  type UploadTarget,
} from './types';

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Any S3-compatible store: AWS S3, Cloudflare R2, MinIO, Backblaze B2, ... */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly options: S3Options,
    private readonly clock: Clock,
  ) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Recent SDK versions add checksum headers/params by default. Presigned URLs would then
      // demand extra headers from a plain client PUT; only compute checksums when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async createUpload(
    key: string,
    o: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<UploadTarget> {
    assertSafeKey(key);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: o.contentType,
        ContentLength: o.contentLength,
      }),
      // Signing these makes S3 reject uploads whose type/length differ from what we authorised.
      {
        expiresIn: o.expiresInSeconds,
        signingDate: this.clock.now(),
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': o.contentType, 'Content-Length': String(o.contentLength) },
      expiresAt: new Date(this.clock.now().getTime() + o.expiresInSeconds * 1000),
    };
  }

  async signedReadUrl(key: string, expiresAt: Date, signingDate?: Date): Promise<string> {
    assertSafeKey(key);
    const signedAt = signingDate ?? this.clock.now();
    const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - signedAt.getTime()) / 1000));
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      {
        expiresIn,
        signingDate: signedAt,
      },
    );
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!(res.Body instanceof Readable)) throw new Error('S3 returned an unreadable body');
    await pipeline(res.Body, createWriteStream(destinationPath));
  }

  async uploadFile(key: string, sourcePath: string, contentType: string): Promise<void> {
    const { size } = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
        ContentLength: size,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.options.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}
