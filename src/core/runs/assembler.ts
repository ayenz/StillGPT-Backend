import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How a scene follows the previous one: a hard cut (default) or a short dissolve (time passes, place changes). */
export type Transition = 'cut' | 'dissolve';

/** One scene clip of a film, with the dialogue lines to caption over it. */
export interface FilmClip {
  path: string;
  captions: string[];
  /** Into this clip from the previous one (ignored for the first). Default `cut`. */
  transition?: Transition;
}

export interface AssembleInput {
  clips: FilmClip[];
  /** Still image shown first (title card), `titleSeconds` long; it dissolves into the first scene. */
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
  /** JPEG stills of a clip at the given fractions of its length (0–1), for quality checks. */
  stills(path: string, at: number[], signal?: AbortSignal): Promise<Buffer[]>;
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

const FPS = 30;
/** Dissolve between two scenes. */
export const DISSOLVE_S = 0.5;
/** Fade from / to black at the very start and end of the film. */
export const EDGE_FADE_S = 0.6;
const AUDIO = 'aformat=sample_rates=48000:channel_layouts=stereo';
const VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const f3 = (n: number) => n.toFixed(3);

/** ffmpeg arguments that normalise one clip (size, fps, timebase, audio track) so every segment joins the same way. */
export function segmentArgs(o: { input: string; out: string; duration: number; hasAudio: boolean; width: number; height: number; still?: boolean }): string[] {
  const d = Math.max(0.5, o.duration);
  const v = `[0:v]scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p,settb=AVTB[v]`;
  const a = `[${o.hasAudio ? '0:a' : '1:a'}]${AUDIO},asettb=AVTB[a]`;
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(o.still ? ['-loop', '1', '-framerate', String(FPS), '-t', f3(d)] : []),
    '-i',
    o.input,
    ...(o.hasAudio ? [] : ['-f', 'lavfi', '-t', f3(d), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
    '-filter_complex',
    `${v};${a}`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...VIDEO_ENCODE,
    ...AUDIO_ENCODE,
    '-t',
    f3(d),
    o.out,
  ];
}

export interface JoinPart {
  path: string;
  duration: number;
  /** Into this part from the previous one; ignored for the first. */
  transition: Transition;
}

/** Where each part starts on the film timeline (a dissolve overlaps the previous part) and the total length. */
export function joinPlan(parts: Pick<JoinPart, 'duration' | 'transition'>[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let end = 0;
  parts.forEach((p, i) => {
    const overlap = i > 0 && p.transition === 'dissolve' ? Math.min(DISSOLVE_S, p.duration / 2, end / 2) : 0;
    const start = end - overlap;
    starts.push(start);
    end = start + p.duration;
  });
  return { starts, total: end };
}

/**
 * One ffmpeg run that joins normalised parts: hard cuts with `concat`, dissolves with `xfade`/`acrossfade`, a fade from
 * black at the start and to black at the end, and loudness normalisation.
 */
export function joinArgs(parts: JoinPart[], out: string, o: { finish?: boolean } = {}): string[] {
  const finish = o.finish ?? true;
  const { total } = joinPlan(parts);
  // every input is brought to the same pixel format, range, timebase and zero-based timestamps first: xfade and concat
  // need identical inputs, and a filter graph this size cannot be re-initialised mid-stream
  const filters: string[] = parts.flatMap((_, i) => [
    `[${i}:v]format=yuv420p,setrange=tv,setsar=1,fps=${FPS},settb=AVTB,setpts=PTS-STARTPTS[i${i}v]`,
    `[${i}:a]${AUDIO},asettb=AVTB,asetpts=PTS-STARTPTS[i${i}a]`,
  ]);
  let v = '[i0v]';
  let a = '[i0a]';
  let end = parts[0]?.duration ?? 0;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    const overlap = p.transition === 'dissolve' ? Math.min(DISSOLVE_S, p.duration / 2, end / 2) : 0;
    if (overlap > 0) {
      filters.push(`${v}[i${i}v]xfade=transition=fade:duration=${f3(overlap)}:offset=${f3(end - overlap)}[v${i}]`);
      filters.push(`${a}[i${i}a]acrossfade=d=${f3(overlap)}[a${i}]`);
    } else {
      filters.push(`${v}[i${i}v]concat=n=2:v=1:a=0[v${i}]`);
      filters.push(`${a}[i${i}a]concat=n=2:v=0:a=1[a${i}]`);
    }
    v = `[v${i}]`;
    a = `[a${i}]`;
    end = end - overlap + p.duration;
  }
  const edge = Math.min(EDGE_FADE_S, total / 4);
  if (finish) {
    filters.push(`${v}fade=t=in:st=0:d=${f3(edge)},fade=t=out:st=${f3(Math.max(0, total - edge))}:d=${f3(edge)},format=yuv420p[vout]`);
    filters.push(`${a}afade=t=in:st=0:d=${f3(edge)},afade=t=out:st=${f3(Math.max(0, total - edge))}:d=${f3(edge)},loudnorm=I=-16:TP=-1.5:LRA=11,${AUDIO}[aout]`);
  } else {
    // an intermediate chunk of a long film: edges and loudness are done once, on the whole film
    filters.push(`${v}format=yuv420p[vout]`);
    filters.push(`${a}${AUDIO}[aout]`);
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...parts.flatMap((p) => ['-reinit_filter', '0', '-i', p.path]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...VIDEO_ENCODE,
    ...AUDIO_ENCODE,
    '-movflags',
    '+faststart',
    out,
  ];
}

/** Above this many parts a film is joined in chunks first (one ffmpeg graph with 100 inputs is slow and memory hungry). */
export const CHUNK_LIMIT = 24;
const CHUNK_SIZE = 20;

/**
 * Splits parts into chunks for a two-level join. Each chunk enters the final join with the transition of its first part,
 * so the timeline (and the caption times from `joinPlan` over all parts) stays the same.
 */
export function chunkParts<T extends { transition: Transition }>(parts: T[], size = CHUNK_SIZE): { parts: T[]; transition: Transition }[] {
  const out: { parts: T[]; transition: Transition }[] = [];
  for (let i = 0; i < parts.length; i += size) {
    const chunk = parts.slice(i, i + size);
    out.push({ parts: chunk, transition: i === 0 ? 'cut' : chunk[0]!.transition });
  }
  return out;
}

export class FfmpegAssembler implements FilmAssembler {
  constructor(
    private readonly ffmpeg: string,
    /** Per ffmpeg run: the final join of a 15-minute 1080p film re-encodes it all (~1× realtime on the ARM server). */
    private readonly timeoutMs = 60 * 60_000,
  ) {}

  async assemble(input: AssembleInput, signal?: AbortSignal): Promise<AssembleOutput> {
    const dir = await mkdtemp(join(tmpdir(), 'stillgpt-film-'));
    try {
      const parts: JoinPart[] = [];
      const captions: string[][] = [];
      if (input.titleCard) {
        const seconds = input.titleSeconds ?? 3;
        const out = join(dir, 'seg_title.mp4');
        await this.run(segmentArgs({ input: input.titleCard, out, duration: seconds, hasAudio: false, width: input.width, height: input.height, still: true }), signal);
        parts.push({ path: out, duration: seconds, transition: 'cut' });
        captions.push([]);
      }
      for (const [i, clip] of input.clips.entries()) {
        const probe = parseProbe(await this.run(['-hide_banner', '-i', clip.path], signal, true));
        if (!probe.duration) throw new Error(`Scene ${i + 1}: ffmpeg could not read the clip`);
        const out = join(dir, `seg_${String(i).padStart(3, '0')}.mp4`);
        await this.run(segmentArgs({ input: clip.path, out, duration: probe.duration, hasAudio: probe.hasAudio, width: input.width, height: input.height }), signal);
        // the title card always dissolves into the first scene
        const transition: Transition = i === 0 ? (input.titleCard ? 'dissolve' : 'cut') : (clip.transition ?? 'cut');
        parts.push({ path: out, duration: probe.duration, transition });
        captions.push(clip.captions);
      }
      const plan = joinPlan(parts);
      const joined = join(dir, 'joined.mp4');
      if (parts.length <= CHUNK_LIMIT) await this.run(joinArgs(parts, joined), signal);
      else {
        const chunks: JoinPart[] = [];
        for (const [c, chunk] of chunkParts(parts).entries()) {
          const file = join(dir, `chunk_${String(c).padStart(2, '0')}.mp4`);
          await this.run(joinArgs(chunk.parts, file, { finish: false }), signal);
          chunks.push({ path: file, duration: joinPlan(chunk.parts).total, transition: chunk.transition });
        }
        await this.run(joinArgs(chunks, joined), signal);
      }

      // a caption ends where the next part starts (a dissolve overlaps them)
      const srt = input.captions
        ? buildSrt(parts.map((p, i) => ({ start: plan.starts[i]!, seconds: Math.min(p.duration, (plan.starts[i + 1] ?? Infinity) - plan.starts[i]!), lines: captions[i]! })))
        : null;
      let film = joined;
      if (srt) {
        const subs = join(dir, 'film.srt');
        await writeFile(subs, srt);
        film = join(dir, 'film.mp4');
        await this.run(['-y', '-hide_banner', '-loglevel', 'error', '-i', joined, '-i', subs, '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c', 'copy', '-c:s', 'mov_text', '-movflags', '+faststart', film], signal);
      }
      return { mp4: await readFile(film), srt, durationS: Math.round(plan.total * 100) / 100 };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async stills(path: string, at: number[], signal?: AbortSignal): Promise<Buffer[]> {
    const { duration } = parseProbe(await this.run(['-hide_banner', '-i', path], signal, true));
    if (!duration) throw new Error('ffmpeg could not read the clip');
    const dir = await mkdtemp(join(tmpdir(), 'stillgpt-stills-'));
    try {
      const out: Buffer[] = [];
      for (const [k, f] of at.entries()) {
        const file = join(dir, `still_${k}.jpg`);
        const t = Math.min(Math.max(0, f * duration), Math.max(0, duration - 0.1));
        await this.run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', f3(t), '-i', path, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '3', file], signal);
        out.push(await readFile(file));
      }
      return out;
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
