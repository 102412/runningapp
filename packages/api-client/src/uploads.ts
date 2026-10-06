import { ApiError, unwrap } from './errors';
import type { ApiClient } from './client';
import type { components } from './generated/schema';

export type Media = components['schemas']['Media'];
export type MediaKind = components['schemas']['MediaKind'];

export interface UploadOptions {
  kind: MediaKind;
  /** e.g. "video/mp4", "image/jpeg". Must match what the server allows (see the upload docs). */
  mimeType: string;
  data: Blob | ArrayBuffer | Uint8Array;
  /** POST (default) for post media, AVATAR for profile pictures. */
  purpose?: 'POST' | 'AVATAR';
  /** Give up waiting for processing after this long (default 3 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each status seen while processing. */
  onStatus?: (media: Media) => void;
  /** Poll interval for processing status (default 1 s, backs off to 4 s). */
  pollMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set<Media['status']>(['READY', 'FAILED', 'REJECTED']);

/**
 * The whole upload dance in one call: reserve an upload, PUT the bytes straight to storage (no auth
 * header: the URL is presigned), tell the API it is done, then wait for processing. Resolves with
 * the READY media; throws ApiError(MEDIA_NOT_READY / MEDIA_REJECTED) if processing failed.
 *
 * For big videos on mobile prefer your platform's background upload API with the instructions from
 * `POST /v1/media/uploads`, then call `waitForMedia`.
 */
export async function uploadMedia(client: ApiClient, options: UploadOptions): Promise<Media> {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const body =
    options.data instanceof Blob ? options.data : new Blob([options.data as ArrayBuffer]);

  const init = unwrap(
    await client.POST('/v1/media/uploads', {
      body: {
        kind: options.kind,
        mimeType: options.mimeType,
        sizeBytes: body.size,
        purpose: options.purpose ?? 'POST',
      },
    }),
  );

  const put = await doFetch(init.upload.url, {
    method: 'PUT',
    headers: init.upload.headers,
    body,
    signal: options.signal ?? null,
  });
  if (!put.ok) {
    throw new ApiError({
      code: 'UNKNOWN',
      message: `Uploading the file failed (HTTP ${put.status}).`,
      status: put.status,
    });
  }

  const done = unwrap(
    await client.POST('/v1/media/{id}/complete', { params: { path: { id: init.media.id } } }),
  );
  options.onStatus?.(done);
  return waitForMedia(client, done, options);
}

/** Polls a media item until it is READY, FAILED or REJECTED. */
export async function waitForMedia(
  client: ApiClient,
  start: Media,
  options: Pick<UploadOptions, 'timeoutMs' | 'signal' | 'onStatus' | 'pollMs' | 'sleep'> = {},
): Promise<Media> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  let media = start;
  let wait = options.pollMs ?? 1000;
  while (!TERMINAL.has(media.status)) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() > deadline) {
      throw new ApiError({
        code: 'MEDIA_NOT_READY',
        message: 'Processing is taking longer than expected. Check again later.',
        status: 0,
      });
    }
    await sleep(wait);
    wait = Math.min(wait * 1.5, 4000);
    media = unwrap(await client.GET('/v1/media/{id}', { params: { path: { id: media.id } } }));
    options.onStatus?.(media);
  }
  if (media.status !== 'READY') {
    throw new ApiError({
      code: media.status === 'REJECTED' ? 'MEDIA_REJECTED' : 'MEDIA_NOT_READY',
      message: `The file could not be processed (${media.failureCode ?? media.status}).`,
      status: 422,
    });
  }
  return media;
}
