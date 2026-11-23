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
  /** Voice-over that starts with this clip. */
  narration?: string;
}

/** A music track looped under clips `from`..`to` (0-based, inclusive). */
export interface MusicTrack {
  path: string;
  from: number;
  to: number;
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
  /** Music bed, ducked under the narration. */
  music?: MusicTrack[];
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
  /** The audio of a file as a small mono MP3 (speech checks of music clips). */
  audio(path: string, signal?: AbortSignal): Promise<Buffer>;
}

/** Mix levels: the music bed sits well under the clips' own sound; the narration sits on top. */
const MUSIC_GAIN = 0.25;
const CLIP_GAIN = 0.85;
const NARRATION_GAIN = 1.6;
/** Music fades and the overlap between consecutive tracks. */
const MUSIC_FADE_S = 1.5;
/** Narration starts this long after its clip. */
const NARRATION_DELAY_S = 0.3;

export interface MixPlan {
  /** Music windows on the film timeline. */
  music: { path: string; start: number; end: number }[];
  narration: { path: string; start: number }[];
}

/**
 * Where music and narration go, from the joined parts' timeline. `offset` = number of parts before the first clip (the
 * title card). The first music window starts at 0 (under the title card); windows overlap by MUSIC_FADE_S to crossfade.
 */
export function mixPlan(input: { clips: FilmClip[]; music?: MusicTrack[] }, starts: number[], durations: number[], offset: number): MixPlan {
  const total = (starts.at(-1) ?? 0) + (durations.at(-1) ?? 0);
  const tracks = [...(input.music ?? [])].sort((a, b) => a.from - b.from);
  const music = tracks.map((t, k) => {
    const from = t.from + offset;
    const to = Math.min(t.to + offset, starts.length - 1);
    const start = k === 0 ? 0 : starts[from]!;
    const end = k === tracks.length - 1 ? total : Math.min(total, starts[to]! + durations[to]! + MUSIC_FADE_S);
    return { path: t.path, start, end };
  });
  const narration = input.clips.flatMap((c, i) => (c.narration ? [{ path: c.narration, start: starts[i + offset]! + NARRATION_DELAY_S }] : []));
  return { music, narration };
}

/** ffmpeg arguments that lay music and narration over the joined film (video copied) and normalise loudness. */
export function mixArgs(video: string, total: number, plan: MixPlan, out: string): string[] {
  const inputs: string[] = ['-i', video];
  const filters: string[] = [];
  let n = 1;
  const music: string[] = [];
  for (const [k, m] of plan.music.entries()) {
    const dur = Math.max(0.5, m.end - m.start);
    const fade = Math.min(MUSIC_FADE_S, dur / 3);
    inputs.push('-stream_loop', '-1', '-i', m.path);
    filters.push(
      `[${n}:a]${AUDIO},atrim=0:${f3(dur)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${f3(fade)},afade=t=out:st=${f3(dur - fade)}:d=${f3(fade)},volume=${MUSIC_GAIN},adelay=${Math.round(m.start * 1000)}:all=1[m${k}]`,
    );
    music.push(`[m${k}]`);
    n++;
  }
  const voices: string[] = [];
  for (const [k, v] of plan.narration.entries()) {
    inputs.push('-i', v.path);
    filters.push(`[${n}:a]${AUDIO},volume=${NARRATION_GAIN},adelay=${Math.round(v.start * 1000)}:all=1[n${k}]`);
    voices.push(`[n${k}]`);
    n++;
  }
  // the bed: the clips' own sound plus the music
  filters.push(`[0:a]${AUDIO},volume=${CLIP_GAIN}[clip]`);
  const mixOf = (labels: string[], name: string) =>
    labels.length === 1 ? `${labels[0]}anull[${name}]` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[${name}]`;
  if (music.length) {
    filters.push(mixOf(music, 'music'));
    filters.push(`[clip][music]amix=inputs=2:normalize=0:duration=first[bed]`);
  } else filters.push('[clip]anull[bed]');
  if (voices.length) {
    // the narration ducks the bed (sidechain) and sits on top
    filters.push(`${mixOf(voices, 'voice0')}`);
    filters.push(`[voice0]apad=whole_dur=${f3(total)},asplit=2[voice][key]`);
    filters.push('[bed][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=500[ducked]');
    filters.push('[ducked][voice]amix=inputs=2:normalize=0:duration=first[mix]');
  } else filters.push('[bed]anull[mix]');
  filters.push(`[mix]loudnorm=I=-16:TP=-1.5:LRA=11,${AUDIO}[aout]`);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    ...AUDIO_ENCODE,
    '-t',
    f3(total),
    '-movflags',
    '+faststart',
    out,
  ];
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

      // music and narration go over the finished picture in one more pass (video copied)
      const offset = input.titleCard ? 1 : 0;
      const mix = mixPlan(input, plan.starts, parts.map((p) => p.duration), offset);
      let picture = joined;
      if (mix.music.length || mix.narration.length) {
        picture = join(dir, 'mixed.mp4');
        await this.run(mixArgs(joined, plan.total, mix, picture), signal);
      }

      // a caption ends where the next part starts (a dissolve overlaps them)
      const srt = input.captions
        ? buildSrt(parts.map((p, i) => ({ start: plan.starts[i]!, seconds: Math.min(p.duration, (plan.starts[i + 1] ?? Infinity) - plan.starts[i]!), lines: captions[i]! })))
        : null;
      let film = picture;
      if (srt) {
        const subs = join(dir, 'film.srt');
        await writeFile(subs, srt);
        film = join(dir, 'film.mp4');
        await this.run(['-y', '-hide_banner', '-loglevel', 'error', '-i', picture, '-i', subs, '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c', 'copy', '-c:s', 'mov_text', '-movflags', '+faststart', film], signal);
      }
      return { mp4: await readFile(film), srt, durationS: Math.round(plan.total * 100) / 100 };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async audio(path: string, signal?: AbortSignal): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'stillgpt-audio-'));
    try {
      const file = join(dir, 'audio.mp3');
      await this.run(['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', file], signal);
      return await readFile(file);
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
