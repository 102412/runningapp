import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { api, drainJobs, type TestUser } from './api';
import type { TestApp } from './app';

const run = promisify(execFile);

/** Runs ffmpeg to synthesise a fixture file and returns its bytes. */
async function ffmpegFixture(args: string[], ext: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fixture-'));
  const out = path.join(dir, `out.${ext}`);
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VideoFixture {
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
  audio?: boolean;
  container?: 'mp4' | 'mov' | 'webm' | 'avi';
  metadata?: Record<string, string>;
}

export function makeVideo(o: VideoFixture = {}): Promise<Buffer> {
  const {
    width = 540,
    height = 960,
    seconds = 2,
    fps = 24,
    audio = true,
    container = 'mp4',
    metadata = {},
  } = o;
  const codecs =
    container === 'webm'
      ? [
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          ...(audio ? ['-c:a', 'libopus'] : ['-an']),
        ]
      : container === 'avi'
        ? ['-c:v', 'mpeg4', ...(audio ? ['-c:a', 'mp3'] : ['-an'])]
        : [
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            ...(audio ? ['-c:a', 'aac'] : ['-an']),
          ];
  const meta = Object.entries(metadata).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return ffmpegFixture(
    [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=duration=${seconds}:size=${width}x${height}:rate=${fps}`,
      ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
      ...codecs,
      ...meta,
      '-shortest',
    ],
    container,
  );
}

export function makeImage(
  o: { width?: number; height?: number; format?: 'jpg' | 'png' | 'webp' | 'gif' } = {},
): Promise<Buffer> {
  const { width = 800, height = 600, format = 'jpg' } = o;
  return ffmpegFixture(
    [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=1`,
      '-frames:v',
      '1',
      ...(format === 'gif' ? ['-loop', '0'] : []),
    ],
    format,
  );
}

/** ffprobe JSON for a buffer (used to assert on what the pipeline produced). */
export async function probeBuffer(
  bytes: Buffer,
): Promise<{
  format: { format_name: string; duration?: string; tags?: Record<string, string> };
  streams: Array<Record<string, unknown>>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const file = path.join(dir, 'f');
  try {
    await (await import('node:fs/promises')).writeFile(file, bytes);
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    return JSON.parse(stdout) as never;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const MIME = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/mp4',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/png',
} as const;

export interface UploadResult {
  id: string;
  media: ReturnType<JSON['parse']>;
}

/** Full client flow: init -> PUT bytes to the presigned URL -> complete -> (optionally) process. */
export async function uploadMedia(
  t: TestApp,
  user: TestUser,
  bytes: Buffer,
  o: { kind: 'VIDEO' | 'IMAGE'; mime: string; purpose?: 'POST' | 'AVATAR'; process?: boolean },
): Promise<UploadResult> {
  const init = await api(t, user).post('/media/uploads', {
    kind: o.kind,
    mimeType: o.mime,
    sizeBytes: bytes.length,
    purpose: o.purpose ?? 'POST',
  });
  if (init.statusCode !== 201) throw new Error(`init failed ${init.statusCode}: ${init.body}`);
  const { media, upload } = init.json();
  const url = new URL(upload.url as string);
  const put = await t.app.inject({
    method: 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: { 'content-type': upload.headers['Content-Type'] as string },
    payload: bytes,
  });
  if (put.statusCode !== 200) throw new Error(`PUT failed ${put.statusCode}: ${put.body}`);
  const done = await api(t, user).post(`/media/${media.id as string}/complete`);
  if (done.statusCode !== 200) throw new Error(`complete failed ${done.statusCode}: ${done.body}`);
  if (o.process !== false) await drainJobs(t);
  const final = await api(t, user).get(`/media/${media.id as string}`);
  return { id: media.id as string, media: final.json() };
}

/** Fetches a signed URL through the app (path + query only). */
export function fetchSigned(t: TestApp, url: string, headers: Record<string, string> = {}) {
  const u = new URL(url);
  return t.app.inject({ method: 'GET', url: `${u.pathname}${u.search}`, headers });
}
