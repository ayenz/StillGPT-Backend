import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closestImageRatio } from '../../src/core/enhancer.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ mock: { videoDelayMs: 100 }, env: { MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const enhance = (payload: unknown) => h.api('/api/v1/prompts/enhance', { method: 'POST', json: payload });

async function upload(width: number, height: number) {
  const png = await sharp({ create: { width, height, channels: 3, background: '#c33' } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'frame.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

const TRAITS = '{"subject":"woman in a red silk gown","outfit":"red silk evening gown","palette":"red, gold","background":"marble ballroom","lighting":"warm chandelier light"}';

/** Scripts the vision and enhancer replies; returns what the enhancer was sent. */
function script(reply: string, opts: { describe?: string } = {}) {
  const seen: string[] = [];
  h.qoder.setReply((text) => {
    if (text.includes('<describe-reference>')) return opts.describe ?? TRAITS;
    if (text.includes('<idea>')) {
      seen.push(text);
      return reply;
    }
    return undefined;
  });
  return seen;
}

describe('closestImageRatio', () => {
  it('maps a picture shape to the nearest allowed ratio', () => {
    expect(closestImageRatio(1080, 1920)).toBe('9:16');
    expect(closestImageRatio(1200, 1000)).toBe('5:4');
    expect(closestImageRatio(500, 500)).toBe('1:1');
    expect(closestImageRatio(4000, 1700)).toBe('21:9');
  });
});

describe('enhance with a video first frame', () => {
  it('describes the frame and asks only for motion, ratio adaptive', async () => {
    const frame = await upload(64, 96);
    const seen = script('{"prompt":"The woman in the red gown slowly turns toward the camera, fabric rippling; slow dolly-in","aspect_ratio":"16:9","seconds":6}');
    const r = await json(await enhance({ prompt: 'make this image moving', kind: 'video', first_frame_file_id: frame.id }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'first_frame', enhanced: true, ratio: 'adaptive', aspect_ratio: 'adaptive', seconds: 6 });
    expect(r.body.references).toEqual([{ file_id: frame.id, cached: false, traits: expect.objectContaining({ outfit: 'red silk evening gown' }) }]);
    expect(seen[0]).toContain('The video STARTS FROM the first frame');
    expect(seen[0]).toContain('First frame 1: {"subject":"woman in a red silk gown"');
    expect(seen[0]).not.toContain('END on the last frame');
  });

  it('first + last frame asks for a transition', async () => {
    const [a, b] = [await upload(64, 64), await upload(64, 64)];
    const seen = script('{"prompt":"transition","aspect_ratio":"1:1","seconds":5}');
    const r = await json(await enhance({ prompt: 'from day to night', kind: 'video', first_frame_file_id: a.id, last_frame_file_id: b.id }));
    expect(r.body.references.map((x: any) => x.file_id)).toEqual([a.id, b.id]);
    expect(seen[0]).toContain('Last frame 1:');
    expect(seen[0]).toContain('END on the last frame');
  });

  it('an unreadable frame is flagged instead of guessed', async () => {
    const frame = await upload(64, 64);
    const seen = script('{"prompt":"the subject moves","aspect_ratio":"16:9","seconds":5}', { describe: 'I cannot see images' });
    const r = await json(await enhance({ prompt: 'gerakin', kind: 'video', first_frame_file_id: frame.id }));
    expect(r.body).toMatchObject({ mode: 'first_frame', references: [{ traits: null }] });
    expect(seen[0]).toContain('could not be read; do not guess');
  });

  it('POST /videos with enhance passes the frame to the enhancer', async () => {
    const frame = await upload(64, 64);
    const seen = script('{"prompt":"The woman twirls, gown flaring","aspect_ratio":"16:9","seconds":4}');
    const r = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'make this image moving', first_frame_file_id: frame.id, enhance: true } }));
    expect(r.status).toBe(202);
    expect(r.body.request).toMatchObject({ prompt: 'The woman twirls, gown flaring', original_prompt: 'make this image moving', mode: 'first_frame_to_video', ratio: 'adaptive', seconds: 4 });
    expect(seen[0]).toContain('STARTS FROM the first frame');
  });

  it('validates', async () => {
    const frame = await upload(64, 64);
    expect((await json(await enhance({ prompt: 'x', kind: 'video', last_frame_file_id: frame.id }))).status).toBe(400);
    expect((await json(await enhance({ prompt: 'x', kind: 'video', first_frame_file_id: 'file_nope' }))).status).toBe(404);
  });
});

describe('enhance with reference images (video)', () => {
  it('keeps the referenced subject', async () => {
    const ref = await upload(64, 64);
    const seen = script('{"prompt":"x","aspect_ratio":"9:16","seconds":5}');
    const r = await json(await enhance({ prompt: 'iklan produk ini di pantai', kind: 'video', reference_file_ids: [ref.id] }));
    expect(r.body).toMatchObject({ mode: 'reference', ratio: 'adaptive' });
    expect(seen[0]).toContain('Keep it exactly as it appears');
  });
});

describe('enhance an image edit', () => {
  it('writes an edit instruction and keeps the input shape', async () => {
    const img = await upload(90, 160);
    const seen = script('{"prompt":"Change the background to a sunny beach; keep the woman, her red gown and pose unchanged","aspect_ratio":"1:1"}');
    const r = await json(await enhance({ prompt: 'ganti background jadi pantai', input_file_ids: [img.id] }));
    expect(r.body).toMatchObject({ mode: 'edit', aspect_ratio: '9:16', size: '1024x1792' });
    expect(seen[0]).toContain('The user is EDITING the image(s) above');
    expect(seen[0]).toContain('Input image 1:');
  });

  it('an explicit ratio in the idea wins over the input shape', async () => {
    const img = await upload(90, 160);
    script('{"prompt":"x","aspect_ratio":"16:9"}');
    const r = await json(await enhance({ prompt: 'bikin versi 16:9', input_file_ids: [img.id] }));
    expect(r.body.aspect_ratio).toBe('16:9');
  });

  it('POST /images with enhance and input images uses the edit mode', async () => {
    const img = await upload(160, 90);
    const seen = script('{"prompt":"Make the gown blue, keep everything else","aspect_ratio":"1:1"}');
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'bajunya jadi biru', input_file_ids: [img.id], enhance: true } }));
    expect(r.body.request).toMatchObject({ prompt: 'Make the gown blue, keep everything else', size: '1792x1024' });
    expect(seen[0]).toContain('EDITING');
  });

  it('text-only enhance is unchanged', async () => {
    const seen = script('{"prompt":"x","aspect_ratio":"4:5"}');
    const r = await json(await enhance({ prompt: 'kucing' }));
    expect(r.body).toMatchObject({ mode: 'text', references: [], aspect_ratio: '4:5' });
    expect(seen[0]).not.toContain('Attached images');
  });
});

describe('variations of a video with a first frame', () => {
  it('defaults to motion/camera/mood and matches the frame', async () => {
    const frame = await upload(64, 64);
    let sent = '';
    h.qoder.setReply((text) => {
      if (text.includes('<describe-reference>')) return TRAITS;
      if (text.includes('<prompt>')) {
        sent = text;
        return '{"variations":[{"prompt":"She spins fast, handheld camera","changed":{"motion":"spin"}}]}';
      }
      return undefined;
    });
    const r = await json(await h.api('/api/v1/prompts/variations', { method: 'POST', json: { prompt: 'She turns slowly', kind: 'video', first_frame_file_id: frame.id } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ vary: ['motion', 'camera', 'mood'], keep: ['subject', 'outfit', 'color', 'background', 'style', 'text'] });
    expect(sent).toContain('starts from a fixed first frame');
    expect(sent).not.toContain('clearly different from these references');
    expect((await json(await h.api('/api/v1/prompts/variations', { method: 'POST', json: { prompt: 'p', first_frame_file_id: frame.id } }))).status).toBe(400);
  });
});
