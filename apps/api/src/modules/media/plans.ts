import type { MediaVariantKind } from '@runningapp/contracts';

/**
 * Pure builders for the ffmpeg invocations that derive playable renditions, posters and
 * thumbnails. Every plan strips ALL metadata (`-map_metadata -1`: removes GPS tags and device
 * info from phones' EXIF/QuickTime atoms), never upscales, and outputs even dimensions.
 */
export interface VariantPlan {
  kind: MediaVariantKind;
  /** File name under the media's storage prefix. */
  name: string;
  mime: string;
  timeoutMs: number;
  args(input: string, output: string): string[];
}

const STRIP = ['-map_metadata', '-1', '-map_chapters', '-1'];

/** Fit inside a W x H box, preserving aspect ratio, never enlarging, even dimensions. */
const fit = (w: number, h: number): string =>
  `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

export interface VideoInfo {
  width: number;
  height: number;
  durationS: number;
  fps: number | undefined;
  hasAudio: boolean;
}

export function planVideoVariants(v: VideoInfo): VariantPlan[] {
  const portrait = v.height >= v.width;
  const [highW, highH] = portrait ? [720, 1280] : [1280, 720];
  const [lowW, lowH] = portrait ? [360, 640] : [640, 360];
  const capFps = v.fps !== undefined && v.fps > 30.5 ? ',fps=30' : '';
  const posterAt = Math.min(1, v.durationS / 2).toFixed(2);

  const encode =
    (box: [number, number], crf: string, maxrate: string, audioKbps: string) =>
    (input: string, output: string): string[] => [
      '-i',
      input,
      '-map',
      '0:v:0',
      ...(v.hasAudio ? ['-map', '0:a:0'] : []),
      '-vf',
      `${fit(box[0], box[1])},format=yuv420p${capFps}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      crf,
      '-maxrate',
      maxrate,
      '-bufsize',
      `${parseInt(maxrate, 10) * 2}M`,
      '-profile:v',
      'high',
      ...(v.hasAudio ? ['-c:a', 'aac', '-b:a', audioKbps, '-ac', '2'] : ['-an']),
      '-movflags',
      '+faststart',
      ...STRIP,
      '-sn',
      '-dn',
      '-threads',
      '2',
      output,
    ];

  const still =
    (box: [number, number]) =>
    (input: string, output: string): string[] => [
      '-ss',
      posterAt,
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      fit(box[0], box[1]),
      '-q:v',
      '3',
      ...STRIP,
      '-update',
      '1',
      output,
    ];

  return [
    {
      kind: 'VIDEO_MP4_HIGH',
      name: 'video-high.mp4',
      mime: 'video/mp4',
      timeoutMs: 6 * 60_000,
      args: encode([highW, highH], '23', '4M', '128k'),
    },
    {
      kind: 'VIDEO_MP4_LOW',
      name: 'video-low.mp4',
      mime: 'video/mp4',
      timeoutMs: 3 * 60_000,
      args: encode([lowW, lowH], '28', '1M', '64k'),
    },
    {
      kind: 'POSTER',
      name: 'poster.jpg',
      mime: 'image/jpeg',
      timeoutMs: 60_000,
      args: still([highW, highH]),
    },
    {
      kind: 'POSTER_THUMB',
      name: 'poster-thumb.jpg',
      mime: 'image/jpeg',
      timeoutMs: 60_000,
      args: still([480, 480]),
    },
  ];
}

export interface ImageInfo {
  width: number;
  height: number;
  /** Avatars are centre-cropped to a square. */
  avatar: boolean;
}

export function planImageVariants(img: ImageInfo): VariantPlan[] {
  const crop = img.avatar ? "crop=w='min(iw,ih)':h='min(iw,ih)'," : '';
  const make = (kind: MediaVariantKind, name: string, edge: number): VariantPlan => ({
    kind,
    name,
    mime: 'image/jpeg',
    timeoutMs: 90_000,
    args: (input, output) => [
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `${crop}${fit(edge, edge)}`,
      '-q:v',
      '3',
      ...STRIP,
      '-update',
      '1',
      output,
    ],
  });
  return [
    make('IMAGE_LARGE', 'image-large.jpg', 2048),
    make('IMAGE_MEDIUM', 'image-medium.jpg', 1080),
    make('IMAGE_THUMB', 'image-thumb.jpg', 480),
  ];
}
