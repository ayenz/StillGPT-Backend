import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One scene clip of a film, with the dialogue lines to caption over it. */
export interface FilmClip {
  path: string;
  captions: string[];
}

export interface AssembleInput {
  clips: FilmClip[];
  /** Still image shown first (title card), `titleSeconds` long. */
  titleCard?: string;
  titleSeconds?: number;
  width: number;
  height: number;
  /** Add the dialogue as a subtitle track (and return the SRT). */
  captions: boolean;
}

export interface AssembleOutput {
  mp4: Buffer;
  /** SubRip captions (also embedded as a soft subtitle track), null without dialogue. */
  srt: string | null;
  durationS: number;
}

/** Turns scene clips into one film. The ffmpeg implementation runs locally; tests use a fake. */
export interface FilmAssembler {
  assemble(input: AssembleInput, signal?: AbortSignal): Promise<AssembleOutput>;
}

/** Output size of a film. */
export function filmSize(ratio: '16:9' | '9:16' | '1:1', resolution: '720P' | '1080P'): { width: number; height: number } {
  const long = resolution === '720P' ? 1280 : 1920;
  const short = resolution === '720P' ? 720 : 1080;
  if (ratio === '9:16') return { width: short, height: long };
  if (ratio === '1:1') return { width: short, height: short };
  return { width: long, height: short };
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
export function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** Captions spread evenly over each clip's window. Returns null when there is nothing to caption. */
export function buildSrt(windows: { start: number; seconds: number; lines: string[] }[]): string | null {
  const cues: string[] = [];
  for (const w of windows) {
    const lines = w.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;
    const slot = w.seconds / lines.length;
    lines.forEach((line, i) => {
      const from = w.start + i * slot + 0.1;
      const to = w.start + (i + 1) * slot - 0.1;
      cues.push(`${cues.length + 1}\n${srtTime(from)} --> ${srtTime(Math.max(from + 0.5, to))}\n${line}\n`);
    });
  }
  return cues.length ? cues.join('\n') : null;
}

/** `Duration: 00:00:05.04` and whether there is an audio stream, from `ffmpeg -i` output. */
export function parseProbe(stderr: string): { duration: number; hasAudio: boolean } {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { duration, hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr) };
}

const FADE = 0.3;
const FPS = 30;
const AUDIO = 'aformat=sample_rates=48000:channel_layouts=stereo';
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

/** ffmpeg arguments that normalise one clip (size, fps, audio track, fades) so the segments concat losslessly. */
export function segmentArgs(o: { input: string; out: string; duration: number; hasAudio: boolean; width: number; height: number; still?: boolean }): string[] {
  const d = Math.max(0.5, o.duration);
  const fadeOut = Math.max(0, d - FADE).toFixed(3);
  const v = `[0:v]scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOut}:d=${FADE}[v]`;
  const a = `[${o.hasAudio ? '0:a' : '1:a'}]${AUDIO},afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a]`;
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(o.still ? ['-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3)] : []),
    '-i',
    o.input,
    ...(o.hasAudio ? [] : ['-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
    '-filter_complex',
    `${v};${a}`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...ENCODE,
    '-t',
    d.toFixed(3),
    o.out,
  ];
}

export class FfmpegAssembler implements FilmAssembler {
  constructor(
    private readonly ffmpeg: string,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  async assemble(input: AssembleInput, signal?: AbortSignal): Promise<AssembleOutput> {
    const dir = await mkdtemp(join(tmpdir(), 'stillgpt-film-'));
    try {
      const segments: string[] = [];
      const windows: { start: number; seconds: number; lines: string[] }[] = [];
      let t = 0;
      if (input.titleCard) {
        const seconds = input.titleSeconds ?? 3;
        const out = join(dir, 'seg_title.mp4');
        await this.run(segmentArgs({ input: input.titleCard, out, duration: seconds, hasAudio: false, width: input.width, height: input.height, still: true }), signal);
        segments.push(out);
        t += seconds;
      }
      for (const [i, clip] of input.clips.entries()) {
        const probe = parseProbe(await this.run(['-hide_banner', '-i', clip.path], signal, true));
        if (!probe.duration) throw new Error(`Scene ${i + 1}: ffmpeg could not read the clip`);
        const out = join(dir, `seg_${String(i).padStart(3, '0')}.mp4`);
        await this.run(segmentArgs({ input: clip.path, out, duration: probe.duration, hasAudio: probe.hasAudio, width: input.width, height: input.height }), signal);
        segments.push(out);
        windows.push({ start: t, seconds: probe.duration, lines: clip.captions });
        t += probe.duration;
      }
      const list = join(dir, 'list.txt');
      await writeFile(list, segments.map((s) => `file '${s.replaceAll("'", "'\\''")}'`).join('\n'));
      const joined = join(dir, 'joined.mp4');
      await this.run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], signal);

      const srt = input.captions ? buildSrt(windows) : null;
      const film = join(dir, 'film.mp4');
      const subs = srt ? join(dir, 'film.srt') : null;
      if (subs) await writeFile(subs, srt!);
      await this.run(
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          joined,
          ...(subs ? ['-i', subs] : []),
          '-map',
          '0:v',
          '-map',
          '0:a',
          ...(subs ? ['-map', '1:s', '-c:s', 'mov_text'] : []),
          '-c:v',
          'copy',
          '-af',
          'loudnorm=I=-16:TP=-1.5:LRA=11',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '48000',
          '-movflags',
          '+faststart',
          film,
        ],
        signal,
      );
      return { mp4: await readFile(film), srt, durationS: Math.round(t * 100) / 100 };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Runs ffmpeg; resolves with stderr. `probe` = `ffmpeg -i` without an output (exit code 1 is expected). */
  private run(args: string[], signal?: AbortSignal, probe = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), this.timeoutMs);
      const onAbort = () => p.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      p.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        if (err.length > 20_000) err = err.slice(-20_000);
      });
      p.on('error', (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code === 0 || probe) resolve(err);
        else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ') || 'no output'}`));
      });
    });
  }
}
