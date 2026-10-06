import { z } from 'zod';
import { MediaKind, MediaPurpose, MediaStatus } from './enums';
import { IdSchema, IsoDateTimeSchema } from './common';

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
] as const;
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MEDIA_FAILURE_CODES = [
  'INVALID_MEDIA',
  'UNSUPPORTED_FORMAT',
  'TOO_LONG',
  'TOO_LARGE_DIMENSIONS',
  'TOO_SMALL',
  'MODERATION_REJECTED',
  'PROCESSING_ERROR',
  'TAKEN_DOWN',
] as const;
export const MediaFailureCode = z.enum(MEDIA_FAILURE_CODES).meta({
  id: 'MediaFailureCode',
  description:
    'Why processing failed. PROCESSING_ERROR is transient and can be retried via POST /media/{id}/retry; the rest are permanent.',
});
export type MediaFailureCode = z.infer<typeof MediaFailureCode>;

export const MediaUrlsSchema = z
  .object({
    playback: z
      .string()
      .nullable()
      .describe('Video: main MP4 (<=720x1280, H.264/AAC, faststart). Stream it directly.'),
    playbackLow: z.string().nullable().describe('Video: data-saver MP4 (<=360x640).'),
    poster: z.string().nullable().describe('Video: poster frame (JPEG).'),
    thumbnail: z
      .string()
      .nullable()
      .describe('Video poster thumbnail or image thumbnail (JPEG, <=480px).'),
    large: z.string().nullable().describe('Image: <=2048px JPEG.'),
    medium: z.string().nullable().describe('Image: <=1080px JPEG.'),
  })
  .meta({
    id: 'MediaUrls',
    description:
      'Signed, expiring URLs. Re-fetch the parent resource when they expire (see urlsExpireAt).',
  });

export const MediaViewSchema = z
  .object({
    id: IdSchema,
    kind: MediaKind.schema,
    purpose: MediaPurpose.schema,
    status: MediaStatus.schema,
    failureCode: MediaFailureCode.nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    aspectRatio: z
      .number()
      .nullable()
      .describe('width / height of the processed media; use it to reserve layout space.'),
    durationMs: z.number().int().nullable(),
    hasAudio: z.boolean().nullable(),
    urls: MediaUrlsSchema,
    urlsExpireAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    readyAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Media' });
export type MediaView = z.infer<typeof MediaViewSchema>;

export const UploadInitRequestSchema = z
  .object({
    kind: MediaKind.schema,
    purpose: MediaPurpose.schema.default('POST'),
    mimeType: z.string().min(3).max(100).describe('One of /v1/media/limits -> allowed*MimeTypes.'),
    sizeBytes: z.number().int().min(1).describe('Exact size of the file you will upload.'),
  })
  .strict();
export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>;

export const UploadInstructionsSchema = z
  .object({
    method: z.literal('PUT'),
    url: z
      .string()
      .describe('Presigned URL. PUT the raw file bytes here (no multipart, no auth header).'),
    headers: z
      .record(z.string(), z.string())
      .describe('Send EXACTLY these headers with the PUT; they are part of the signature.'),
    expiresAt: IsoDateTimeSchema,
  })
  .meta({ id: 'UploadInstructions' });

export const UploadInitResponseSchema = z
  .object({ media: MediaViewSchema, upload: UploadInstructionsSchema })
  .meta({ id: 'UploadInitResponse' });

export const MediaLimitsSchema = z
  .object({
    maxVideoBytes: z.number().int(),
    maxVideoSeconds: z.number().int(),
    maxImageBytes: z.number().int(),
    maxMediaPerPost: z.number().int(),
    allowedVideoMimeTypes: z.array(z.string()),
    allowedImageMimeTypes: z.array(z.string()),
  })
  .meta({ id: 'MediaLimits' });
