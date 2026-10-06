import { spawn } from 'node:child_process';

export interface ProbeStream {
  codecType: string;
  codecName: string;
  /** Display width/height after applying rotation metadata. */
  width: number | undefined;
  height: number | undefined;
  avgFrameRate: number | undefined;
  bitRate: number | undefined;
}

export interface ProbeResult {
  formatName: string;
  durationS: number | undefined;
  sizeBytes: number | undefined;
  bitRate: number | undefined;
  streams: ProbeStream[];
}

/** Input the media tools could not make sense of (corrupt, wrong type): not worth retrying. */
export class BadMediaError extends Error {}
/** Tool/infrastructure trouble (timeout, killed, disk full): worth retrying. */
export class MediaToolError extends Error {}

const MAX_STDERR = 16_384;
const INFRA_HINTS =
  /no space left|cannot allocate memory|out of memory|resource temporarily unavailable/i;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function exec(command: string, args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new MediaToolError(`Failed to start ${command}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new MediaToolError(`${command} timed out after ${timeoutMs}ms`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

const parseRate = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const [n, d] = v.split('/').map(Number);
  return n !== undefined && d !== undefined && d > 0 && Number.isFinite(n / d) ? n / d : undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export class Ffmpeg {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async probe(file: string, timeoutMs = 30_000): Promise<ProbeResult> {
    const run = await exec(
      this.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      timeoutMs,
    );
    if (run.signal) throw new MediaToolError(`ffprobe was killed (${run.signal})`);
    if (run.code !== 0) {
      if (INFRA_HINTS.test(run.stderr)) throw new MediaToolError(run.stderr.trim().slice(0, 300));
      throw new BadMediaError(run.stderr.trim().slice(0, 300) || 'ffprobe could not read the file');
    }
    let json: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
    try {
      json = JSON.parse(run.stdout) as typeof json;
    } catch {
      throw new BadMediaError('ffprobe produced unreadable output');
    }
    const streams: ProbeStream[] = (json.streams ?? []).map((s) => {
      let w = num(s.width);
      let h = num(s.height);
      const side = Array.isArray(s.side_data_list)
        ? (s.side_data_list as Array<Record<string, unknown>>)
        : [];
      const rotation = Math.abs(
        num(side.find((d) => d.rotation !== undefined)?.rotation) ??
          num((s.tags as Record<string, unknown> | undefined)?.rotate) ??
          0,
      );
      if (rotation % 180 === 90 && w !== undefined && h !== undefined) [w, h] = [h, w];
      return {
        codecType: str(s.codec_type),
        codecName: str(s.codec_name),
        width: w,
        height: h,
        avgFrameRate: parseRate(s.avg_frame_rate),
        bitRate: num(s.bit_rate),
      };
    });
    return {
      formatName: str(json.format?.format_name),
      durationS: num(json.format?.duration),
      sizeBytes: num(json.format?.size),
      bitRate: num(json.format?.bit_rate),
      streams,
    };
  }

  /** Runs ffmpeg with the given arguments (argv array: never a shell string). */
  async run(args: string[], timeoutMs: number): Promise<void> {
    const run = await exec(
      this.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
      timeoutMs,
    );
    if (run.signal) throw new MediaToolError(`ffmpeg was killed (${run.signal})`);
    if (run.code !== 0) {
      const detail = run.stderr.trim().slice(0, 400);
      if (INFRA_HINTS.test(run.stderr)) throw new MediaToolError(detail);
      throw new BadMediaError(detail || `ffmpeg exited with code ${run.code}`);
    }
  }
}
