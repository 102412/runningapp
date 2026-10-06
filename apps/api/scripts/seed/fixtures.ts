import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Synthesises small, deterministic media files with ffmpeg (no external assets, nothing
 * downloaded). Each "look" is a different lavfi source so the seeded feed is visually varied.
 */
export class Fixtures {
  private readonly dir = path.join(os.tmpdir(), 'runningapp-seed-fixtures');

  constructor(private readonly ffmpeg: string) {}

  async available(): Promise<boolean> {
    try {
      await run(this.ffmpeg, ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async make(name: string, args: string[]): Promise<Buffer> {
    const out = path.join(this.dir, name);
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
    return readFile(out);
  }

  /** Vertical 3-second clip with a tone, like a phone recording. */
  video(look: number): Promise<Buffer> {
    const sources = [
      'testsrc2=size=540x960:rate=24:duration=3',
      'gradients=size=540x960:rate=24:duration=3:speed=0.06:seed=7',
      'mandelbrot=size=540x960:rate=24',
      'life=size=540x960:rate=24:mold=10:ratio=0.1:death_color=#1b4965:life_color=#fca311',
      'cellauto=size=540x960:rate=24:rule=110:random_fill_ratio=0.3',
    ];
    const source = sources[look % sources.length] as string;
    return this.make(`video-${look}.mp4`, [
      '-f',
      'lavfi',
      '-i',
      source,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${300 + (look % 5) * 90}:duration=3`,
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
    ]);
  }

  photo(look: number): Promise<Buffer> {
    const sources = [
      'testsrc2=size=900x1125:rate=1',
      'gradients=size=900x1125:rate=1:seed=3',
      'smptebars=size=900x1125:rate=1',
      'mandelbrot=size=900x1125:rate=1',
    ];
    return this.make(`photo-${look}.jpg`, [
      '-f',
      'lavfi',
      '-i',
      sources[look % sources.length] as string,
      '-frames:v',
      '1',
    ]);
  }

  /** A flat-colour square, used for profile pictures. */
  avatar(hexColor: string): Promise<Buffer> {
    return this.make(`avatar-${hexColor}.jpg`, [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${hexColor}:s=512x512:r=1`,
      '-frames:v',
      '1',
    ]);
  }
}
