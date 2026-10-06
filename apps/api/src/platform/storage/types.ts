export interface UploadTarget {
  method: 'PUT';
  url: string;
  /** Headers the client MUST send exactly as given (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | undefined;
}

/**
 * S3-semantics object storage. Two drivers: `local` (disk + HMAC-signed URLs served by this API,
 * development only) and `s3` (AWS S3, Cloudflare R2, MinIO...). Application code never knows which.
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  /** Presigned upload so large files go straight to storage, never through the API process. */
  createUpload(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<UploadTarget>;
  head(key: string): Promise<StoredObjectInfo | null>;
  downloadToFile(key: string, destinationPath: string): Promise<void>;
  uploadFile(key: string, sourcePath: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
  /**
   * A time-limited GET URL. `signingDate` lets callers pin the signature to a time bucket so the
   * same URL is returned for a while (client-side image/video caches key on the URL).
   */
  signedReadUrl(key: string, expiresAt: Date, signingDate?: Date): Promise<string>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Object keys are always server-generated, but they end up in file paths and URLs, so they are
 * validated defensively anyway: no traversal, no absolute paths, no empty segments.
 */
export function assertSafeKey(key: string): void {
  const segments = key.split('/');
  const ok =
    key.length > 0 &&
    key.length <= 300 &&
    segments.length >= 2 &&
    segments.every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..' && !s.includes('..'));
  if (!ok) throw new Error(`Unsafe storage key: ${JSON.stringify(key.slice(0, 80))}`);
}

export function contentTypeForKey(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
