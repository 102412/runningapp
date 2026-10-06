import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  type Avatar,
  type MediaFailureCode,
  type MediaView,
  type UploadInitRequest,
} from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { isForeignKeyViolation } from '../../platform/db/errors';
import { AppError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { jobSpec, type JobQueue } from '../../platform/jobs/queue';
import type { JobContext } from '../../platform/jobs/worker';
import type { ContentModerator } from '../../platform/ports/content-moderation';
import type { ObjectStorage } from '../../platform/storage/types';
import { BadMediaError, type Ffmpeg, MediaToolError, type ProbeResult } from './ffmpeg';
import { planImageVariants, planVideoVariants, type VariantPlan } from './plans';

export const MediaProcessJob = jobSpec('media.process', z.object({ mediaId: z.uuid() }), {
  maxAttempts: 3,
});
/** Emitted (transactionally) when media reaches READY/FAILED/REJECTED so dependents can react. */
export const MediaStatusChangedJob = jobSpec(
  'media.status_changed',
  z.object({ mediaId: z.uuid(), status: z.enum(['READY', 'FAILED', 'REJECTED']) }),
  { maxAttempts: 5 },
);
export const MediaDeleteObjectsJob = jobSpec(
  'media.delete_objects',
  z.object({ keys: z.array(z.string()).min(1).max(500) }),
  {
    maxAttempts: 8,
  },
);
export const MediaCleanupJob = jobSpec('media.cleanup', z.object({}), { maxAttempts: 3 });

const MAX_PENDING_UPLOADS = 20;
const UPLOAD_GRACE_MS = 60 * 60_000;
const MAX_VIDEO_PIXELS = 3840 * 2160;
const MIN_DIMENSION = 64;
const MAX_VIDEO_DURATION_TOLERANCE_S = 0.5;
const VIDEO_FORMATS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'];
const IMAGE_FORMATS = ['image2', 'jpeg_pipe', 'png_pipe', 'webp_pipe'];
const IMAGE_CODECS = ['mjpeg', 'png', 'webp'];

type MediaRow = {
  id: string;
  ownerId: string;
  kind: 'VIDEO' | 'IMAGE';
  purpose: 'POST' | 'AVATAR';
  status: MediaView['status'];
  storageKey: string;
  declaredMime: string;
  declaredSizeBytes: number;
  failureCode: string | null;
  createdAt: Date;
  readyAt: Date | null;
};

interface ProducedVariant {
  plan: VariantPlan;
  file: string;
  size: number;
  probe: ProbeResult;
}

type TransformOutcome =
  | { ok: false; code: MediaFailureCode; detail: string }
  | {
      ok: true;
      variants: ProducedVariant[];
      meta: {
        width: number;
        height: number;
        durationMs?: number;
        hasAudio?: boolean;
        fps?: number;
        videoCodec?: string;
        audioCodec?: string;
        bitrateKbps?: number;
      };
      reviewFile: string;
    };

export class MediaService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly storage: ObjectStorage,
    private readonly jobs: JobQueue,
    private readonly ffmpeg: Ffmpeg,
    private readonly moderator: ContentModerator,
    private readonly logger: {
      warn: (o: object, m: string) => void;
      info: (o: object, m: string) => void;
    },
  ) {}

  limits() {
    return {
      maxVideoBytes: this.config.MEDIA_MAX_VIDEO_BYTES,
      maxVideoSeconds: this.config.MEDIA_MAX_VIDEO_SECONDS,
      maxImageBytes: this.config.MEDIA_MAX_IMAGE_BYTES,
      maxMediaPerPost: 10,
      allowedVideoMimeTypes: [...ALLOWED_VIDEO_MIME_TYPES],
      allowedImageMimeTypes: [...ALLOWED_IMAGE_MIME_TYPES],
    };
  }

  // ------------------------------------------------------------------ upload lifecycle

  async initUpload(ownerId: string, input: UploadInitRequest) {
    const allowed: readonly string[] =
      input.kind === 'VIDEO' ? ALLOWED_VIDEO_MIME_TYPES : ALLOWED_IMAGE_MIME_TYPES;
    if (!allowed.includes(input.mimeType)) {
      throw new AppError('UNSUPPORTED_FILE', {
        message: `Unsupported ${input.kind.toLowerCase()} type "${input.mimeType}".`,
      });
    }
    if (input.purpose === 'AVATAR' && input.kind !== 'IMAGE') {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'purpose', message: 'Avatars must be images.' }],
      });
    }
    const maxBytes =
      input.kind === 'VIDEO'
        ? this.config.MEDIA_MAX_VIDEO_BYTES
        : this.config.MEDIA_MAX_IMAGE_BYTES;
    if (input.sizeBytes > maxBytes) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'sizeBytes', message: `Maximum is ${maxBytes} bytes.` }],
      });
    }

    const now = this.clock.now();
    const pending = await this.db
      .selectFrom('mediaAssets')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('ownerId', '=', ownerId)
      .where('status', '=', 'PENDING_UPLOAD')
      .where('uploadExpiresAt', '>', now)
      .executeTakeFirstOrThrow();
    if (Number(pending.n) >= MAX_PENDING_UPLOADS) {
      throw new AppError('RATE_LIMITED', {
        message: 'Too many unfinished uploads. Finish or wait for them to expire.',
        headers: { 'retry-after': '300' },
      });
    }

    const id = uuidv7();
    const storageKey = `media/${ownerId}/${id}/original`;
    const expiresAt = new Date(now.getTime() + this.config.UPLOAD_URL_TTL_SECONDS * 1000);
    await this.db
      .insertInto('mediaAssets')
      .values({
        id,
        ownerId,
        kind: input.kind,
        purpose: input.purpose,
        storageKey,
        declaredMime: input.mimeType,
        declaredSizeBytes: input.sizeBytes,
        uploadExpiresAt: expiresAt,
      })
      .execute();
    const target = await this.storage.createUpload(storageKey, {
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      expiresInSeconds: this.config.UPLOAD_URL_TTL_SECONDS,
    });
    const media = await this.getOwned(ownerId, id);
    return {
      media,
      upload: {
        method: target.method,
        url: target.url,
        headers: target.headers,
        expiresAt: target.expiresAt.toISOString(),
      },
    };
  }

  /** The client calls this after its PUT succeeds. Verifies the object, then queues processing. */
  async complete(ownerId: string, id: string): Promise<MediaView> {
    const row = await this.requireOwnedRow(ownerId, id);
    if (row.status !== 'PENDING_UPLOAD') return this.getOwned(ownerId, id); // idempotent

    const info = await this.storage.head(row.storageKey);
    if (!info)
      throw new AppError('UPLOAD_INCOMPLETE', {
        message: 'No uploaded file was found. PUT the file to the upload URL first.',
      });
    if (info.sizeBytes !== row.declaredSizeBytes) {
      await this.storage.delete(row.storageKey); // never keep a file that differs from what was authorised
      throw new AppError('UPLOAD_INCOMPLETE', {
        message: `Uploaded ${info.sizeBytes} bytes but ${row.declaredSizeBytes} were declared. Upload again.`,
      });
    }

    await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mediaAssets')
        .set({ status: 'UPLOADED', uploadedAt: this.clock.now(), actualSizeBytes: info.sizeBytes })
        .where('id', '=', id)
        .where('status', '=', 'PENDING_UPLOAD')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) > 0)
        await this.jobs.enqueue(MediaProcessJob, { mediaId: id }, { db: trx });
    });
    return this.getOwned(ownerId, id);
  }

  async retry(ownerId: string, id: string): Promise<MediaView> {
    const row = await this.requireOwnedRow(ownerId, id);
    if (row.status !== 'FAILED')
      throw new AppError('INVALID_STATE', { message: 'Only FAILED media can be retried.' });
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('mediaAssets')
        .set({
          status: 'PROCESSING',
          failureCode: null,
          failureDetail: null,
          processingStartedAt: this.clock.now(),
        })
        .where('id', '=', id)
        .where('status', '=', 'FAILED')
        .execute();
      await this.jobs.enqueue(
        MediaProcessJob,
        { mediaId: id },
        { db: trx, dedupeKey: `media.process:${id}` },
      );
    });
    return this.getOwned(ownerId, id);
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.requireOwnedRow(ownerId, id);
    try {
      await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('mediaAssets')
          .select('storageKey')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const variants = await trx
          .selectFrom('mediaVariants')
          .select('storageKey')
          .where('mediaId', '=', id)
          .execute();
        // Deleting a row that a post references fails on the FK (RESTRICT): attached media is protected.
        await trx.deleteFrom('mediaAssets').where('id', '=', id).execute();
        await this.jobs.enqueue(
          MediaDeleteObjectsJob,
          { keys: [row.storageKey, ...variants.map((v) => v.storageKey)] },
          { db: trx },
        );
      });
    } catch (err) {
      if (isForeignKeyViolation(err))
        throw new AppError('MEDIA_ALREADY_ATTACHED', {
          message: 'Remove this media from its post first.',
        });
      throw err;
    }
  }

  // ------------------------------------------------------------------ reads

  async getOwned(ownerId: string, id: string): Promise<MediaView> {
    await this.requireOwnedRow(ownerId, id);
    const view = (await this.viewsByIds([id])).get(id);
    if (!view) throw new AppError('MEDIA_NOT_FOUND');
    return view;
  }

  private async requireOwnedRow(ownerId: string, id: string): Promise<MediaRow> {
    const row = await this.db
      .selectFrom('mediaAssets')
      .select([
        'id',
        'ownerId',
        'kind',
        'purpose',
        'status',
        'storageKey',
        'declaredMime',
        'declaredSizeBytes',
        'failureCode',
        'createdAt',
        'readyAt',
      ])
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new AppError('MEDIA_NOT_FOUND'); // someone else's media is "not found"
    return row;
  }

  /**
   * Presentation for many media at once (4 queries). Signed URLs are minted only for READY media.
   * NOTE: performs no authorisation; callers decide whether the viewer may see these ids.
   */
  async viewsByIds(ids: readonly string[]): Promise<Map<string, MediaView>> {
    const out = new Map<string, MediaView>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;

    const [rows, videos, images, variants] = await Promise.all([
      this.db.selectFrom('mediaAssets').selectAll().where('id', 'in', unique).execute(),
      this.db.selectFrom('videoAssets').selectAll().where('mediaId', 'in', unique).execute(),
      this.db.selectFrom('imageAssets').selectAll().where('mediaId', 'in', unique).execute(),
      this.db
        .selectFrom('mediaVariants')
        .select(['mediaId', 'kind', 'storageKey'])
        .where('mediaId', 'in', unique)
        .execute(),
    ]);
    const videoById = new Map(videos.map((v) => [v.mediaId, v]));
    const imageById = new Map(images.map((i) => [i.mediaId, i]));
    const variantsById = new Map<string, Map<string, string>>();
    for (const v of variants) {
      const m = variantsById.get(v.mediaId) ?? new Map<string, string>();
      m.set(v.kind, v.storageKey);
      variantsById.set(v.mediaId, m);
    }

    const { expiresAt, signingDate } = this.urlWindow();
    const sign = (key: string | undefined): Promise<string | null> =>
      key ? this.storage.signedReadUrl(key, expiresAt, signingDate) : Promise.resolve(null);

    for (const r of rows) {
      const v = videoById.get(r.id);
      const i = imageById.get(r.id);
      const keys = variantsById.get(r.id) ?? new Map<string, string>();
      const ready = r.status === 'READY';
      const [playback, playbackLow, poster, posterThumb, large, medium, imageThumb] = ready
        ? await Promise.all([
            sign(keys.get('VIDEO_MP4_HIGH')),
            sign(keys.get('VIDEO_MP4_LOW')),
            sign(keys.get('POSTER')),
            sign(keys.get('POSTER_THUMB')),
            sign(keys.get('IMAGE_LARGE')),
            sign(keys.get('IMAGE_MEDIUM')),
            sign(keys.get('IMAGE_THUMB')),
          ])
        : [null, null, null, null, null, null, null];
      out.set(r.id, {
        id: r.id,
        kind: r.kind,
        purpose: r.purpose,
        status: r.status,
        failureCode: r.failureCode as MediaFailureCode | null,
        width: v?.width ?? i?.width ?? null,
        height: v?.height ?? i?.height ?? null,
        aspectRatio: v?.aspectRatio ?? i?.aspectRatio ?? null,
        durationMs: v?.durationMs ?? null,
        hasAudio: v ? v.hasAudio : null,
        urls: {
          playback,
          playbackLow,
          poster,
          thumbnail: posterThumb ?? imageThumb,
          large,
          medium,
        },
        urlsExpireAt: ready ? expiresAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        readyAt: r.readyAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  /**
   * Signed URLs for media are pinned to half-TTL time buckets so the same URL is returned for a
   * long stretch: client image/video caches key on the URL, and fresh signatures per request
   * would defeat them.
   */
  private urlWindow(): { expiresAt: Date; signingDate: Date } {
    const ttlMs = this.config.MEDIA_URL_TTL_SECONDS * 1000;
    const bucketMs = ttlMs / 2;
    const now = this.clock.now().getTime();
    const windowStart = Math.floor(now / bucketMs) * bucketMs;
    return { signingDate: new Date(windowStart), expiresAt: new Date(windowStart + ttlMs) };
  }

  /** For UserDirectory: avatar media id -> signed thumbnail/medium URLs. */
  readonly resolveAvatars = async (mediaIds: string[]): Promise<Map<string, Avatar>> => {
    const out = new Map<string, Avatar>();
    if (mediaIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('mediaVariants as v')
      .innerJoin('mediaAssets as m', 'm.id', 'v.mediaId')
      .select(['v.mediaId', 'v.kind', 'v.storageKey'])
      .where('v.mediaId', 'in', mediaIds)
      .where('m.status', '=', 'READY')
      .where('v.kind', 'in', ['IMAGE_THUMB', 'IMAGE_MEDIUM'])
      .execute();
    const { expiresAt, signingDate } = this.urlWindow();
    const grouped = new Map<string, { thumb?: string; medium?: string }>();
    for (const r of rows) {
      const g = grouped.get(r.mediaId) ?? {};
      const url = await this.storage.signedReadUrl(r.storageKey, expiresAt, signingDate);
      if (r.kind === 'IMAGE_THUMB') g.thumb = url;
      else g.medium = url;
      grouped.set(r.mediaId, g);
    }
    for (const [id, g] of grouped) {
      if (g.thumb && g.medium) out.set(id, { thumbUrl: g.thumb, mediumUrl: g.medium });
    }
    return out;
  };

  /** Validates that `mediaId` can be used as `purpose` by `ownerId` right now (READY, theirs). */
  async assertReadyOwned(
    ownerId: string,
    mediaId: string,
    purpose: 'POST' | 'AVATAR',
  ): Promise<void> {
    const row = await this.requireOwnedRow(ownerId, mediaId);
    if (row.purpose !== purpose)
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'mediaId', message: `Media was uploaded for ${row.purpose}.` }],
      });
    if (row.status === 'REJECTED') throw new AppError('MEDIA_REJECTED');
    if (row.status !== 'READY') throw new AppError('MEDIA_NOT_READY');
  }

  // ------------------------------------------------------------------ processing (job handler)

  readonly handleProcess = async (payload: { mediaId: string }, ctx: JobContext): Promise<void> => {
    const row = await this.db
      .selectFrom('mediaAssets')
      .select([
        'id',
        'ownerId',
        'kind',
        'purpose',
        'status',
        'storageKey',
        'declaredMime',
        'declaredSizeBytes',
        'failureCode',
        'createdAt',
        'readyAt',
      ])
      .where('id', '=', payload.mediaId)
      .executeTakeFirst();
    if (!row || (row.status !== 'UPLOADED' && row.status !== 'PROCESSING')) return; // already handled: idempotent
    if (row.status === 'UPLOADED') {
      await this.db
        .updateTable('mediaAssets')
        .set({ status: 'PROCESSING', processingStartedAt: this.clock.now() })
        .where('id', '=', row.id)
        .where('status', '=', 'UPLOADED')
        .execute();
    }

    const work = await mkdtemp(path.join(os.tmpdir(), 'runningapp-media-'));
    const uploadedKeys: string[] = [];
    try {
      const original = path.join(work, 'original');
      await this.storage.downloadToFile(row.storageKey, original);
      const outcome = await this.transform(row, original, work);
      if (!outcome.ok) {
        await this.finish(row, 'REJECTED', outcome.code, outcome.detail);
        return;
      }

      const review = await this.moderator.moderateImage({
        filePath: outcome.reviewFile,
        ownerId: row.ownerId,
      });
      if (review.verdict === 'BLOCK') {
        await this.finish(row, 'REJECTED', 'MODERATION_REJECTED', review.reason);
        return;
      }

      for (const v of outcome.variants) {
        const key = `media/${row.ownerId}/${row.id}/${v.plan.name}`;
        await this.storage.uploadFile(key, v.file, v.plan.mime);
        uploadedKeys.push(key);
      }
      await this.db.transaction().execute(async (trx) => {
        if (row.kind === 'VIDEO') {
          await trx
            .insertInto('videoAssets')
            .values({
              mediaId: row.id,
              durationMs: outcome.meta.durationMs ?? 1,
              width: outcome.meta.width,
              height: outcome.meta.height,
              fps: outcome.meta.fps ?? null,
              videoCodec: outcome.meta.videoCodec ?? null,
              audioCodec: outcome.meta.audioCodec ?? null,
              hasAudio: outcome.meta.hasAudio ?? false,
              bitrateKbps: outcome.meta.bitrateKbps ?? null,
            })
            .onConflict((oc) => oc.column('mediaId').doNothing())
            .execute();
        } else {
          await trx
            .insertInto('imageAssets')
            .values({ mediaId: row.id, width: outcome.meta.width, height: outcome.meta.height })
            .onConflict((oc) => oc.column('mediaId').doNothing())
            .execute();
        }
        await trx
          .insertInto('mediaVariants')
          .values(
            outcome.variants.map((v) => ({
              mediaId: row.id,
              kind: v.plan.kind,
              storageKey: `media/${row.ownerId}/${row.id}/${v.plan.name}`,
              mimeType: v.plan.mime,
              sizeBytes: v.size,
              width: v.probe.streams[0]?.width ?? null,
              height: v.probe.streams[0]?.height ?? null,
              bitrateKbps: v.probe.bitRate ? Math.round(v.probe.bitRate / 1000) : null,
            })),
          )
          .onConflict((oc) => oc.columns(['mediaId', 'kind']).doNothing())
          .execute();
        // The database refuses this transition unless metadata + variants exist (media_not_ready).
        await trx
          .updateTable('mediaAssets')
          .set({ status: 'READY', moderationStatus: 'APPROVED', readyAt: this.clock.now() })
          .where('id', '=', row.id)
          .where('status', '=', 'PROCESSING')
          .execute();
        await this.jobs.enqueue(
          MediaStatusChangedJob,
          { mediaId: row.id, status: 'READY' },
          { db: trx },
        );
      });
    } catch (err) {
      if (uploadedKeys.length > 0)
        await this.storage.deleteMany(uploadedKeys).catch(() => undefined);
      if (err instanceof BadMediaError) {
        await this.finish(row, 'REJECTED', 'INVALID_MEDIA', err.message);
        return;
      }
      this.logger.warn({ err, mediaId: row.id, attempt: ctx.attempt }, 'media processing failed');
      if (ctx.isFinalAttempt) {
        await this.finish(
          row,
          'FAILED',
          'PROCESSING_ERROR',
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      throw err; // retried with backoff
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  /** Terminal failure/rejection: records why, drops the original, and notifies dependents. */
  private async finish(
    row: MediaRow,
    status: 'FAILED' | 'REJECTED',
    code: MediaFailureCode,
    detail: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('mediaAssets')
        .set({
          status,
          failureCode: code,
          failureDetail: detail.slice(0, 500),
          moderationStatus: code === 'MODERATION_REJECTED' ? 'REJECTED' : 'PENDING',
        })
        .where('id', '=', row.id)
        .where('status', 'in', ['UPLOADED', 'PROCESSING'])
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) return;
      // A rejected original must not linger in storage. (FAILED keeps it so retry can run.)
      if (status === 'REJECTED')
        await this.jobs.enqueue(MediaDeleteObjectsJob, { keys: [row.storageKey] }, { db: trx });
      await this.jobs.enqueue(MediaStatusChangedJob, { mediaId: row.id, status }, { db: trx });
    });
  }

  private async transform(
    row: MediaRow,
    original: string,
    work: string,
  ): Promise<TransformOutcome> {
    const probe = await this.ffmpeg.probe(original).catch((err: unknown) => {
      if (err instanceof BadMediaError) return null;
      throw err;
    });
    if (!probe) return { ok: false, code: 'INVALID_MEDIA', detail: 'Not a readable media file.' };
    return row.kind === 'VIDEO'
      ? this.transformVideo(probe, original, work)
      : this.transformImage(row, probe, original, work);
  }

  private async transformVideo(
    probe: ProbeResult,
    original: string,
    work: string,
  ): Promise<TransformOutcome> {
    if (!VIDEO_FORMATS.includes(probe.formatName)) {
      return {
        ok: false,
        code: probe.streams.some((s) => s.codecType === 'video')
          ? 'UNSUPPORTED_FORMAT'
          : 'INVALID_MEDIA',
        detail: `Container "${probe.formatName}" is not accepted.`,
      };
    }
    const video = probe.streams.find((s) => s.codecType === 'video' && s.width && s.height);
    if (!video?.width || !video.height)
      return { ok: false, code: 'INVALID_MEDIA', detail: 'No video stream.' };
    const duration = probe.durationS ?? 0;
    if (duration < 0.3)
      return { ok: false, code: 'INVALID_MEDIA', detail: 'Video is empty or too short.' };
    if (duration > this.config.MEDIA_MAX_VIDEO_SECONDS + MAX_VIDEO_DURATION_TOLERANCE_S) {
      return {
        ok: false,
        code: 'TOO_LONG',
        detail: `Duration ${duration.toFixed(1)}s exceeds ${this.config.MEDIA_MAX_VIDEO_SECONDS}s.`,
      };
    }
    if (video.width < MIN_DIMENSION || video.height < MIN_DIMENSION)
      return {
        ok: false,
        code: 'TOO_SMALL',
        detail: `${video.width}x${video.height} is too small.`,
      };
    if (video.width * video.height > MAX_VIDEO_PIXELS)
      return {
        ok: false,
        code: 'TOO_LARGE_DIMENSIONS',
        detail: `${video.width}x${video.height} exceeds 4K.`,
      };

    const plans = planVideoVariants({
      width: video.width,
      height: video.height,
      durationS: duration,
      fps: video.avgFrameRate,
      hasAudio: probe.streams.some((s) => s.codecType === 'audio'),
    });
    const variants = await this.runPlans(original, work, plans);
    const high = variants.find((v) => v.plan.kind === 'VIDEO_MP4_HIGH');
    const poster = variants.find((v) => v.plan.kind === 'POSTER');
    const hv = high?.probe.streams.find((s) => s.codecType === 'video');
    if (!high || !poster || !hv?.width || !hv.height)
      throw new MediaToolError('Transcode produced no playable output');
    return {
      ok: true,
      variants,
      reviewFile: poster.file,
      meta: {
        width: hv.width,
        height: hv.height,
        durationMs: Math.max(1, Math.round((high.probe.durationS ?? duration) * 1000)),
        hasAudio: high.probe.streams.some((s) => s.codecType === 'audio'),
        fps: hv.avgFrameRate,
        videoCodec: hv.codecName,
        audioCodec: high.probe.streams.find((s) => s.codecType === 'audio')?.codecName,
        bitrateKbps: high.probe.bitRate ? Math.round(high.probe.bitRate / 1000) : undefined,
      },
    };
  }

  private async transformImage(
    row: MediaRow,
    probe: ProbeResult,
    original: string,
    work: string,
  ): Promise<TransformOutcome> {
    const img = probe.streams.find((s) => s.codecType === 'video' && s.width && s.height);
    if (!img?.width || !img.height)
      return { ok: false, code: 'INVALID_MEDIA', detail: 'No image stream.' };
    if (!IMAGE_FORMATS.includes(probe.formatName) || !IMAGE_CODECS.includes(img.codecName)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_FORMAT',
        detail: `Format "${probe.formatName}/${img.codecName}" is not accepted.`,
      };
    }
    if (img.width < 32 || img.height < 32)
      return { ok: false, code: 'TOO_SMALL', detail: `${img.width}x${img.height} is too small.` };
    if (img.width * img.height > this.config.MEDIA_MAX_PIXELS)
      return {
        ok: false,
        code: 'TOO_LARGE_DIMENSIONS',
        detail: `${img.width}x${img.height} is too many pixels.`,
      };

    const variants = await this.runPlans(
      original,
      work,
      planImageVariants({ width: img.width, height: img.height, avatar: row.purpose === 'AVATAR' }),
    );
    const medium = variants.find((v) => v.plan.kind === 'IMAGE_MEDIUM');
    const ms = medium?.probe.streams[0];
    if (!medium || !ms?.width || !ms.height)
      throw new MediaToolError('Image conversion produced no output');
    // Dimensions reported to clients are those of the LARGE variant (the canonical full image).
    const large = variants.find((v) => v.plan.kind === 'IMAGE_LARGE')?.probe.streams[0] ?? ms;
    return {
      ok: true,
      variants,
      reviewFile: medium.file,
      meta: { width: large.width ?? ms.width, height: large.height ?? ms.height },
    };
  }

  private async runPlans(
    original: string,
    work: string,
    plans: VariantPlan[],
  ): Promise<ProducedVariant[]> {
    const out: ProducedVariant[] = [];
    for (const plan of plans) {
      const file = path.join(work, plan.name);
      await this.ffmpeg.run(plan.args(original, file), plan.timeoutMs);
      const probe = await this.ffmpeg.probe(file);
      const size = probe.sizeBytes;
      if (!size || size <= 0) throw new MediaToolError(`Variant ${plan.name} is empty`);
      out.push({ plan, file, size, probe });
    }
    return out;
  }

  // ------------------------------------------------------------------ housekeeping

  readonly handleDeleteObjects = async (payload: { keys: string[] }): Promise<void> => {
    await this.storage.deleteMany(payload.keys);
  };

  /** Removes abandoned upload slots (the client never completed them). */
  readonly handleCleanup = async (): Promise<void> => {
    const cutoff = new Date(this.clock.now().getTime() - UPLOAD_GRACE_MS);
    const stale = await this.db
      .selectFrom('mediaAssets')
      .select(['id', 'storageKey'])
      .where('status', '=', 'PENDING_UPLOAD')
      .where('uploadExpiresAt', '<', cutoff)
      .limit(500)
      .execute();
    if (stale.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('mediaAssets')
        .where(
          'id',
          'in',
          stale.map((s) => s.id),
        )
        .where('status', '=', 'PENDING_UPLOAD')
        .execute();
      await this.jobs.enqueue(
        MediaDeleteObjectsJob,
        { keys: stale.map((s) => s.storageKey) },
        { db: trx },
      );
    });
    this.logger.info({ count: stale.length }, 'removed abandoned upload slots');
  };
}
