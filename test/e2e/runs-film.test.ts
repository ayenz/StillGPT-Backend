import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type AssembleInput, buildSrt, chunkParts, filmSize, joinArgs, joinPlan, parseProbe, segmentArgs, srtTime } from '../../src/core/runs/assembler.js';
import { applyFixes, normalize, type Script } from '../../src/core/runs/film.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Records what the film kind asks to assemble; returns the clips' bytes joined as the "film". */
class FakeAssembler {
  calls: AssembleInput[] = [];
  stillCalls: { path: string; at: number[] }[] = [];
  async stills(path: string, at: number[]) {
    this.stillCalls.push({ path, at });
    return at.map(() => makePng());
  }
  async assemble(input: AssembleInput) {
    this.calls.push(input);
    const parts = await Promise.all(input.clips.map((c) => readFile(c.path)));
    const windows = input.clips.map((c, i) => ({ start: i * 5, seconds: 5, lines: c.captions }));
    return { mp4: Buffer.concat(parts), srt: input.captions ? buildSrt(windows) : null, durationS: input.clips.length * 5 + (input.titleCard ? 3 : 0) };
  }
}

const assembler = new FakeAssembler();
const pushes: string[] = [];
let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    env: { RUN_RETRY_BASE_MS: '5', VAPID_PUBLIC_KEY: 'BOr5r1c3rPpGgG2yBtUfgnTwSsUk3nOMv4J1K2DzRcwE2xtJq2b2yL7m3Y4sX1Qq6T0J7S3a0h9t6F8F1W1y2Z0', VAPID_PRIVATE_KEY: 'x'.repeat(43) },
    filmAssembler: assembler,
    pushSender: async (_t, payload) => void pushes.push(payload),
  });
  // a browser subscription, so device notifications would be visible
  await h.ctx.push.subscribe(h.userId, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }, 'test');
});
afterEach(() => {
  h.qoder.setReply(undefined);
  assembler.calls = [];
  pushes.length = 0;
});
afterAll(() => h?.close());

const json = async (res: Response) => (await res.json()) as any;

async function waitRun(id: string, until = (r: any) => ['completed', 'failed', 'cancelled', 'awaiting_input'].includes(r.status)) {
  for (let i = 0; i < 1200; i++) {
    const r = await json(await h.api(`/api/v1/runs/${id}`));
    if (until(r)) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${id} did not settle`);
}

const SCRIPT: Script = {
  title: 'Kopi Pagi',
  logline: 'A barista finds her rhythm.',
  style_bible: { look: 'warm 35mm', palette: 'amber', lighting: 'morning sun', camera: 'handheld' },
  characters: [
    { id: 'sari', name: 'Sari', appearance: 'young woman, short black hair', wardrobe: 'green apron', face: null },
    { id: 'budi', name: 'Budi', appearance: 'older man, grey beard', wardrobe: 'batik shirt', face: null },
  ],
  locations: [{ id: 'cafe', name: 'Small cafe', description: 'warm wooden cafe with a copper espresso machine' }],
  scenes: [
    { seconds: 6, location_id: 'cafe', location: 'small cafe', action: 'Sari opens the shutters', camera: 'wide', characters: ['sari'], dialogue: [], sfx: 'metal shutter', mood: 'calm', continuous: true, transition: 'cut' },
    { seconds: 14, location_id: 'cafe', location: 'counter', action: 'Sari pours latte art', camera: 'close', characters: ['sari', 'ghost'], dialogue: [{ character: 'Sari', line: 'Selamat pagi!' }], sfx: '', mood: 'warm', continuous: false, transition: 'dissolve' },
    { seconds: 5, location: 'table', action: 'Budi tastes and smiles', camera: 'medium', characters: ['budi'], dialogue: [{ character: 'Budi', line: 'Enak sekali.' }], sfx: '', mood: 'joy', continuous: false, transition: 'dissolve' },
  ],
};

interface Seen {
  clipChecks: string[];
  scripts: number;
  writer: string[];
  checks: string[];
  frames: string[];
}

/** Writer replies the script (draft + revision), the vision check gives `score(scene)`. */
function script(score: (t: string) => number = () => 4, clipScore: (t: string) => number = () => 4): Seen {
  const seen: Seen = { clipChecks: [], scripts: 0, writer: [], checks: [], frames: [] };
  h.qoder.setReply((t) => {
    if (t.startsWith('You are a screenwriter') || t.startsWith('You are a film editor')) {
      seen.scripts++;
      seen.writer.push(t);
      return JSON.stringify(SCRIPT);
    }
    if (t.includes('You check a keyframe')) {
      seen.checks.push(t);
      return JSON.stringify({ score: score(t), problems: ['melted hands'] });
    }
    if (t.includes('You check one scene')) {
      seen.clipChecks.push(t);
      return JSON.stringify({ score: clipScore(t), problems: ['face morphs at the end'] });
    }
    if (t.includes('Cinematic film still')) seen.frames.push(t);
    return undefined;
  });
  return seen;
}

describe('film helpers', () => {
  it('formats SRT times and spreads captions over each clip', () => {
    expect(srtTime(3723.456)).toBe('01:02:03,456');
    const srt = buildSrt([
      { start: 0, seconds: 4, lines: [] },
      { start: 4, seconds: 6, lines: ['A: hi', 'B: hello'] },
    ])!;
    expect(srt).toBe('1\n00:00:04,100 --> 00:00:06,900\nA: hi\n\n2\n00:00:07,100 --> 00:00:09,900\nB: hello\n');
    expect(buildSrt([{ start: 0, seconds: 3, lines: [' '] }])).toBeNull();
  });

  it('parses ffmpeg -i output and builds normalising segment args', () => {
    const probe = parseProbe('  Duration: 00:00:05.04, start: 0\n  Stream #0:0[0x1](und): Video: h264\n  Stream #0:1[0x2](und): Audio: aac (LC)');
    expect(probe).toEqual({ duration: 5.04, hasAudio: true });
    expect(parseProbe('Duration: 00:01:00.00\n Stream #0:0: Video: h264').hasAudio).toBe(false);
    const silent = segmentArgs({ input: 'in.mp4', out: 'o.mp4', duration: 5, hasAudio: false, width: 1920, height: 1080 });
    expect(silent).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(silent.join(' ')).toContain('[1:a]aformat');
    expect(silent.join(' ')).not.toContain('fade'); // scenes are joined with cuts/dissolves, not faded one by one
    // cuts concat, dissolves overlap by 0.5 s; the film fades in/out only at its edges
    expect(joinPlan([{ duration: 3, transition: 'cut' }, { duration: 6, transition: 'dissolve' }, { duration: 4, transition: 'cut' }])).toEqual({ starts: [0, 2.5, 8.5], total: 12.5 });
    const join = joinArgs([{ path: 'a.mp4', duration: 3, transition: 'cut' }, { path: 'b.mp4', duration: 6, transition: 'dissolve' }, { path: 'c.mp4', duration: 4, transition: 'cut' }], 'out.mp4').join(' ');
    expect(join).toContain('[i0v][i1v]xfade=transition=fade:duration=0.500:offset=2.500[v1]');
    expect(join).toContain('[v1][i2v]concat=n=2:v=1:a=0[v2]');
    expect(join).toContain('[a1][i2a]concat=n=2:v=0:a=1[a2]');
    expect(join).toContain('fade=t=out:st=11.900:d=0.600');
    expect(join.match(/-reinit_filter 0 -i/g)).toHaveLength(3);
    const still = segmentArgs({ input: 't.png', out: 'o.mp4', duration: 3, hasAudio: false, width: 1080, height: 1920, still: true });
    expect(still.slice(4, 9)).toEqual(['-loop', '1', '-framerate', '30', '-t']);
    expect(filmSize('9:16', '1080P')).toEqual({ width: 1080, height: 1920 });
    expect(filmSize('1:1', '720P')).toEqual({ width: 720, height: 720 });
  });

  it('clamps scene lengths to the pacing, drops unknown characters and cuts after a continuous shot', () => {
    const n = normalize(SCRIPT, 60, null);
    expect(n.scenes.map((s) => s.seconds)).toEqual([6, 10, 6]); // balanced: 6–10 s
    expect(n.scenes[1]!.characters).toEqual(['sari']);
    // scene 1 continues into scene 2, so scene 2 is a cut even though the writer asked for a dissolve
    expect(n.scenes.map((s) => s.transition)).toEqual(['cut', 'cut', 'dissolve']);
    expect(normalize(SCRIPT, 60, null, 'long').scenes.map((s) => s.seconds)).toEqual([10, 14, 10]);
    expect(normalize(SCRIPT, 60, null, 'fast').scenes.map((s) => s.seconds)).toEqual([6, 6, 5]);
    const folax = normalize(SCRIPT, 10, 5);
    expect(folax.scenes.map((s) => s.seconds)).toEqual([5, 5]);
  });
});

describe('film runs', () => {
  it('scripts, casts, draws, animates and assembles a film into the gallery', async () => {
    const seen = script((t) => (t.includes('Sari pours latte art') && !t.includes('fixed') ? 2 : 4));
    const before = (await json(await h.api('/api/v1/jobs?limit=100'))).data.length;
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'film pendek tentang barista', duration_s: 20, review: 'none' } } }));
    const done = await waitRun(run.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');

    expect(seen.scripts).toBe(2); // draft + revision
    const keys: string[] = done.steps.map((s: any) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['script', 'script_revise', 'cast:sari', 'cast:budi', 'frame:1', 'frame:2', 'frame:3', 'frame:2:fix', 'clip:1', 'clip:2', 'clip:3', 'title_card', 'assemble']));
    expect(keys).not.toContain('frame:1:fix');
    // the weak keyframe was redrawn with the checker's problems as a note
    expect(seen.frames.some((f) => f.includes('Avoid: melted hands'))).toBe(true);
    // keyframes are drawn with the cast sheets of their characters
    const frame3 = done.steps.find((s: any) => s.key === 'frame:3');
    const job3 = await json(await h.api(`/api/v1/jobs/${frame3.output.job_id}`));
    expect(job3.request.input_file_ids).toEqual([done.result.cast.find((c: any) => c.id === 'budi').file_id]);
    expect(job3.request).toMatchObject({ run_id: run.id, film_role: 'keyframe', scene: 3 });
    // scene 1 is continuous: its clip ends on keyframe 2
    const clip1 = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'clip:1').output.job_id}`));
    expect(clip1.request).toMatchObject({ mode: 'first_frame_to_video', first_frame_file_id: done.result.storyboard[0], last_frame_file_id: done.result.storyboard[1], seconds: 6, audio: true, run_id: run.id });
    const clip2 = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'clip:2').output.job_id}`));
    expect(clip2.request.seconds).toBe(10); // 14 s clamped to VideoGen's scene limit
    expect(clip2.request.prompt).toContain('Sari says: "Selamat pagi!"');

    // assembly: clips in scene order with their dialogue, title card first, 1080p 16:9
    expect(assembler.calls).toHaveLength(1);
    const a = assembler.calls[0]!;
    expect(a).toMatchObject({ width: 1920, height: 1080, captions: true, titleSeconds: 3 });
    expect(a.titleCard).toBeTruthy();
    expect(a.clips.map((c) => c.captions)).toEqual([[], ['Sari: Selamat pagi!'], ['Budi: Enak sekali.']]);
    expect(a.clips.map((c) => c.transition)).toEqual(['cut', 'cut', 'dissolve']);

    const r = done.result;
    expect(r).toMatchObject({ title: 'Kopi Pagi', duration_s: 18, open_path: `/gallery/${r.job_id}` });
    expect(r.files.map((f: any) => f.name)).toEqual(['kopi-pagi.mp4', 'kopi-pagi.srt']);
    expect(r.text).toContain('# Kopi Pagi');

    // only the finished film shows in the gallery; scenes, frames and sheets stay out of it
    const gallery = (await json(await h.api('/api/v1/jobs?limit=100'))).data;
    expect(gallery.length).toBe(before + 1);
    expect(gallery[0]).toMatchObject({ id: r.job_id, kind: 'video', status: 'completed' });
    expect(gallery[0].request).toMatchObject({ film_run_id: run.id, mode: 'film' });
    expect(gallery[0].outputs[0].name).toBe('kopi-pagi.mp4');
    // one notification, for the film, opening it in the gallery
    await new Promise((res) => setTimeout(res, 100));
    expect(pushes.map((p) => JSON.parse(p))).toEqual([expect.objectContaining({ title: 'Short film ready', url: `/gallery/${r.job_id}` })]);
  });

  it('pauses on the storyboard, redraws scenes on request, then continues', async () => {
    const seen = script();
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'barista', duration_s: 15, ratio: '9:16', captions: false, title_card: false, pacing: 'long' } } }));
    const first = await waitRun(run.id);
    expect(first.status).toBe('awaiting_input');
    expect(first.state.awaiting).toMatchObject({ key: 'storyboard_review:1', what: 'storyboard' });
    expect(first.state.awaiting.frames).toHaveLength(3);
    expect(first.steps.some((s: any) => s.key.startsWith('clip:'))).toBe(false);
    // long takes: the writer is asked for 10–20 s scenes and real cuts
    expect(seen.writer[0]).toContain('Each scene is 10–20 s. Pacing: few long, flowing takes');
    expect(seen.writer[0]).toContain('Never fade to black between scenes');
    const original2 = first.state.awaiting.frames[1].file_id;

    await h.api(`/api/v1/runs/${run.id}/input`, { method: 'POST', json: { value: { redo: [{ n: 2, note: 'make it rain outside' }] } } });
    const second = await waitRun(run.id, (r) => r.status === 'awaiting_input' && r.state.awaiting.key === 'storyboard_review:2');
    expect(second.state.awaiting.frames[1].file_id).not.toBe(original2);
    expect(second.state.awaiting.frames[0].file_id).toBe(first.state.awaiting.frames[0].file_id);
    expect(seen.frames.some((f) => f.includes("Director's note: make it rain outside"))).toBe(true);

    await h.api(`/api/v1/runs/${run.id}/input`, { method: 'POST', json: { value: null } });
    const done = await waitRun(run.id, (r) => ['completed', 'failed'].includes(r.status));
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(done.result.storyboard[1]).toBe(second.state.awaiting.frames[1].file_id);
    expect(assembler.calls[0]).toMatchObject({ width: 1080, height: 1920, captions: false, titleCard: undefined });
    expect(done.result.files.map((f: any) => f.name)).toEqual(['kopi-pagi.mp4']);
  });

  it('casts a saved face into its character', async () => {
    script();
    h.qoder.setReply((t) => {
      if (t.startsWith('You are a screenwriter')) {
        expect(t).toContain('1 = Mbak Rina');
        return JSON.stringify({ ...SCRIPT, characters: [{ ...SCRIPT.characters[0], face: 1 }, SCRIPT.characters[1]] });
      }
      if (t.startsWith('You are a film editor')) return JSON.stringify({ ...SCRIPT, characters: [{ ...SCRIPT.characters[0], face: 1 }, SCRIPT.characters[1]] });
      if (t.includes('You check a keyframe')) return '{"score":5}';
      return undefined;
    });
    const form = new FormData();
    const { makePng } = await import('../mock-qoder/index.js');
    form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'rina.png');
    const upload = await json(await h.api('/api/v1/files', { method: 'POST', body: form }));
    const face = await json(await h.api('/api/v1/faces', { method: 'POST', json: { name: 'Mbak Rina', file_id: upload.id } }));
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'barista', duration_s: 15, review: 'none', cast_face_ids: [face.id] } } }));
    const done = await waitRun(run.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    const sari = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'cast:sari').output.job_id}`));
    expect(sari.request.input_file_ids).toEqual([upload.id]);
    expect(sari.request.prompt).toContain('keep exactly that face');
    const budi = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'cast:budi').output.job_id}`));
    expect(budi.request.input_file_ids ?? []).toEqual([]);
  });
});

describe('film from reference photos', () => {
  it('casts the person in a reference photo and passes place photos on as looks', async () => {
    const writerPrompts: string[] = [];
    const scripted = { ...SCRIPT, characters: [{ ...SCRIPT.characters[0]!, face: 1 }, SCRIPT.characters[1]!] };
    const { makePng } = await import('../mock-qoder/index.js');
    const uploadPng = async (name: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), name);
      return json(await h.api('/api/v1/files', { method: 'POST', body: form }));
    };
    const person = await uploadPng('lian.png');
    const palace = await uploadPng('palace.png');
    h.qoder.setReply((t) => {
      if (t.includes('A director attached this photo')) {
        return t.includes('reference photo 1 of 2')
          ? '{"kind":"person","description":"Young woman with black hair in a low bun with gold pins, red silk Ming robe with an embroidered dragon square."}'
          : '{"kind":"place","description":"Red palace walls and golden roofs of the Forbidden City at dawn."}';
      }
      if (t.startsWith('You are a screenwriter') || t.startsWith('You are a film editor')) {
        writerPrompts.push(t);
        return JSON.stringify(scripted);
      }
      if (t.includes('You check a keyframe')) return '{"score":5}';
      return undefined;
    });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'dayang istana kabur di pagi hari', attachments: [person.id, palace.id], duration_s: 15, review: 'none' } } }));
    const done = await waitRun(run.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(done.steps.map((s: any) => s.key)).toEqual(expect.arrayContaining(['ref:1', 'ref:2']));
    expect(done.state.references).toHaveLength(2);
    expect(writerPrompts).toHaveLength(2);
    for (const p of writerPrompts) {
      expect(p).toContain('1 = the person in reference photo 1: Young woman with black hair');
      expect(p).toContain('<reference_photos>');
      expect(p).toContain('Forbidden City at dawn');
    }
    // Sari (face 1) is drawn from the person photo, with the palace photo as a look; Budi gets the palace photo only
    const sari = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'cast:sari').output.job_id}`));
    expect(sari.request.input_file_ids).toEqual([person.id, palace.id]);
    expect(sari.request.prompt).toContain('keep exactly that face');
    const budi = await json(await h.api(`/api/v1/jobs/${done.steps.find((s: any) => s.key === 'cast:budi').output.job_id}`));
    expect(budi.request.input_file_ids).toEqual([palace.id]);
    expect(budi.request.prompt).toContain('The input images are costume, place or style references');
  });
});

describe('film without ffmpeg', () => {
  it('fails at the assembly step with a clear error, after the scenes exist', async () => {
    const bare = await startHarness({ env: { RUN_RETRY_BASE_MS: '5', FFMPEG_PATH: '/nonexistent/ffmpeg' } });
    try {
      bare.qoder.setReply((t) => (t.startsWith('You are a screenwriter') || t.startsWith('You are a film editor') ? JSON.stringify({ ...SCRIPT, scenes: SCRIPT.scenes.slice(0, 1) }) : undefined));
      const run = (await (await bare.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'x', duration_s: 10, review: 'none', title_card: false } } })).json()) as any;
      let r: any;
      for (let i = 0; i < 400; i++) {
        r = await (await bare.api(`/api/v1/runs/${run.id}`)).json();
        if (['completed', 'failed'].includes(r.status)) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(r.status).toBe('failed');
      expect(r.error.code).toBe('ffmpeg_unavailable');
      expect(r.steps.find((s: any) => s.key === 'clip:1').status).toBe('completed');
    } finally {
      await bare.close();
    }
  });
});

describe('long films and quality', () => {
  it('chunks long joins and applies continuity fixes', () => {
    const parts = Array.from({ length: 45 }, (_, i) => ({ transition: (i % 7 === 0 ? 'dissolve' : 'cut') as 'cut' | 'dissolve' }));
    const chunks = chunkParts(parts);
    expect(chunks.map((c) => c.parts.length)).toEqual([20, 20, 5]);
    // a chunk enters the final join with its first part's transition (part 21 = index 20 is a cut, index 42 a dissolve)
    expect(chunks.map((c) => c.transition)).toEqual(['cut', 'cut', 'cut']);
    expect(chunkParts(parts, 21)[2]!.transition).toBe('dissolve');
    const inner = joinArgs([{ path: 'a.mp4', duration: 3, transition: 'cut' }, { path: 'b.mp4', duration: 4, transition: 'cut' }], 'o.mp4', { finish: false }).join(' ');
    expect(inner).not.toContain('loudnorm');
    expect(inner).not.toContain('fade=t=in');
    const scenes = [
      { action: 'a', location_id: 'x', characters: ['p'], camera: '', transition: 'cut' as const },
      { action: 'b', location_id: 'x', characters: ['p'], camera: '', transition: 'cut' as const },
    ];
    expect(applyFixes(scenes, [{ n: 2, transition: 'dissolve', characters: [] }, { n: 9, action: 'ignored' }])).toEqual([scenes[0], { ...scenes[1], transition: 'dissolve', characters: [] }]);
  });

  it('writes a long film as acts in parallel with a continuity pass, and re-takes a bad clip', async () => {
    const seen = { outline: 0, acts: [] as string[], continuity: '' };
    const sceneOf = (act: number, k: number) => ({ seconds: 8, location_id: act === 1 ? 'palace' : 'garden', location: 'L', action: `act ${act} scene ${k}`, camera: 'wide', characters: ['lin'], dialogue: [], sfx: '', mood: '', continuous: false, transition: 'cut' });
    h.qoder.setReply((t) => {
      if (t.includes('Outline a 4-minute film')) {
        seen.outline++;
        return JSON.stringify({
          title: 'Kabut Istana',
          logline: 'x',
          style_bible: { look: 'misty' },
          characters: [{ id: 'lin', name: 'Lin', appearance: 'young woman', wardrobe: 'red robe' }],
          locations: [
            { id: 'palace', name: 'Palace', description: 'red walls' },
            { id: 'garden', name: 'Garden', description: 'lotus pond' },
          ],
          acts: [
            { title: 'Escape', summary: 'she slips out', seconds: 100 },
            { title: 'Return', summary: 'she comes back', seconds: 140 },
          ],
        });
      }
      if (t.startsWith('You write the shooting script of act')) {
        seen.acts.push(t);
        const act = t.includes('of act 1 of 2') ? 1 : 2;
        return JSON.stringify({ scenes: [1, 2].map((k) => sceneOf(act, k)) });
      }
      if (t.startsWith('You are the continuity editor')) {
        seen.continuity = t;
        return JSON.stringify({ fixes: [{ n: 3, transition: 'dissolve', reason: 'time jump between acts' }] });
      }
      if (t.includes('You check a keyframe')) return '{"score":5}';
      if (t.includes('You check one scene')) return t.includes('act 2 scene 2') ? '{"score":2,"problems":["face morphs"]}' : '{"score":4}';
      return undefined;
    });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'film', input: { prompt: 'dayang kabur dari istana', duration_s: 240, review: 'none', title_card: false } } }));
    const done = await waitRun(run.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(seen.outline).toBe(1);
    expect(seen.acts).toHaveLength(2);
    // every act writer sees the whole story and knows which act is theirs
    expect(seen.acts.find((t) => t.includes('of act 2 of 2'))).toContain('Act 2 (THIS ACT): Return (140 s)');
    // the act lengths were scaled to the film: 100/240 and 140/240 of 240 s
    expect(done.state.outline.acts.map((a: any) => a.seconds)).toEqual([100, 140]);
    expect(seen.continuity).toContain('4. [act 2] garden | lin | cut | act 2 scene 2');
    const s = done.result.script;
    expect(s.scenes.map((x: any) => [x.act, x.action, x.transition])).toEqual([
      [1, 'act 1 scene 1', 'cut'],
      [1, 'act 1 scene 2', 'cut'],
      [2, 'act 2 scene 1', 'dissolve'],
      [2, 'act 2 scene 2', 'cut'],
    ]);
    // one establishing image per place; keyframes get the cast sheet and the place last
    const keys: string[] = done.steps.map((x: any) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['outline', 'act:1', 'act:2', 'continuity', 'location:palace', 'location:garden']));
    const frame1 = await json(await h.api(`/api/v1/jobs/${done.steps.find((x: any) => x.key === 'frame:1').output.job_id}`));
    const lin = done.result.cast.find((c: any) => c.id === 'lin').file_id;
    const palace = done.state.locations.find((l: any) => l.id === 'palace').file_id;
    expect(frame1.request.input_file_ids).toEqual([lin, palace]);
    expect(frame1.request.prompt).toContain('The last input image shows the location "Palace"');
    // clip checks: 3 stills per clip; the bad clip (scene 4) is re-taken once and the re-take is used
    expect(keys.filter((k) => k.startsWith('check:clip:'))).toHaveLength(4);
    expect(keys).toContain('clip:4:fix');
    expect(keys.filter((k) => k.endsWith(':fix') && k.startsWith('clip:'))).toEqual(['clip:4:fix']);
    const retake = await json(await h.api(`/api/v1/jobs/${done.steps.find((x: any) => x.key === 'clip:4:fix').output.job_id}`));
    expect(retake.request.prompt).toContain('Avoid: face morphs');
    expect(done.result.clips[3]).toBe(retake.outputs[0].id);
    expect(done.state.clip_checks.map((c: any) => [c.n, c.retake])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    const call = assembler.calls.at(-1)!;
    expect(call.clips).toHaveLength(4);
    expect(call.clips.map((c) => c.transition)).toEqual(['cut', 'cut', 'dissolve', 'cut']);
  });
});
