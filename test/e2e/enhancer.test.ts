import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseEnhancerReply, PromptEnhancer } from '../../src/core/enhancer.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
let enhancer: PromptEnhancer;
beforeAll(async () => {
  h = await startHarness();
  enhancer = new PromptEnhancer({ conversations: h.ctx.conversations, turns: h.ctx.turns, log: h.ctx.log });
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

describe('parseEnhancerReply', () => {
  it('accepts plain JSON, fenced JSON and chatter around it', () => {
    expect(parseEnhancerReply('{"prompt":"a cat","aspect_ratio":"1:1"}')).toEqual({ prompt: 'a cat', aspect_ratio: '1:1' });
    expect(parseEnhancerReply('```json\n{"prompt":"a cat","aspect_ratio":"16:9"}\n```')?.aspect_ratio).toBe('16:9');
    expect(parseEnhancerReply('Sure! {"prompt":"x","seconds":"8"} hope it helps')?.seconds).toBe(8);
    expect(parseEnhancerReply('I cannot help with that.')).toBeNull();
    expect(parseEnhancerReply('{"prompt":""}')).toBeNull();
  });
});

describe('PromptEnhancer', () => {
  it('rewrites an image idea and maps the ratio to an ImageGen size', async () => {
    let seen = '';
    h.qoder.setReply((text) => {
      seen = text;
      return '{"prompt":"Studio e-commerce photo of a plus-size model with a curvy, full-figured silhouette wearing a flowing batik maxi dress","aspect_ratio":"3:4"}';
    });
    const r = await enhancer.enhance({ userId: h.userId, prompt: 'poster promo baju wanita busty, ada tulisan "Diskon 50%"', purpose: 'poster' });
    expect(r.enhanced).toBe(true);
    expect(r.prompt).toMatch(/plus-size/);
    expect(r.aspect_ratio).toBe('3:4');
    expect(r.size).toBe('768x1024');
    expect(r.model).toBe('kmodel_latest'); // `enhancer` alias: qmodel_latest/gmodel/dmodel are not in the mock catalogue → next in chain
    // the instructions carry the commercial/body-type guidance and the idea verbatim
    expect(seen).toMatch(/plus-size model with a curvy, full-figured silhouette/);
    expect(seen).toContain('Diskon 50%');
    expect(seen).toContain('Purpose: poster.');
  });

  it('suggests ratio and duration for video', async () => {
    h.qoder.setReply(() => '{"prompt":"Slow dolly-in on a golden retriever walking along Cheonggyecheon","aspect_ratio":"9:16","seconds":8}');
    const r = await enhancer.enhance({ userId: h.userId, prompt: 'anjing jalan di sungai seoul, buat reels', kind: 'video' });
    expect(r).toMatchObject({ enhanced: true, kind: 'video', ratio: '9:16', aspect_ratio: '9:16', seconds: 8 });
  });

  it('keeps the original prompt when the reply is unusable', async () => {
    h.qoder.setReply(() => 'Maaf, saya tidak bisa membantu.');
    const r = await enhancer.enhance({ userId: h.userId, prompt: 'kucing oren' });
    expect(r).toMatchObject({ enhanced: false, prompt: 'kucing oren', aspect_ratio: '1:1', size: '1024x1024' });
  });

  it('hides enhancer conversations from the conversation list', async () => {
    h.qoder.setReply(() => '{"prompt":"x","aspect_ratio":"1:1"}');
    await enhancer.enhance({ userId: h.userId, prompt: 'apa saja' });
    const { data } = await h.ctx.conversations.list(h.userId);
    expect(data.some((c) => c.metadata?.purpose === 'prompt_enhancer')).toBe(false);
  });

  it('archives its one-shot Qoder session right after the turn', async () => {
    h.qoder.setReply(() => '{"prompt":"x","aspect_ratio":"1:1"}');
    const before = new Set(h.qoder.state.sessions.keys());
    await enhancer.enhance({ userId: h.userId, prompt: 'sekali pakai' });
    const created = [...h.qoder.state.sessions.values()].filter((s) => !before.has(s.id));
    expect(created).toHaveLength(1);
    await expect.poll(() => created[0]!.archived_at).toBeTruthy();
  });

  it('validates input', async () => {
    await expect(enhancer.enhance({ userId: h.userId, prompt: '  ' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

/** Scripts the enhancer LLM reply; other turns (image/video generation) keep the default mock behaviour. */
const enhancerReplies = (reply: string) => h.qoder.setReply((text) => (text.includes('<idea>') ? reply : undefined));

async function waitForJob(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await json(await h.api(`/api/v1/jobs/${id}`))).body;
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not finish`);
}

describe('POST /api/v1/prompts/enhance', () => {
  it('returns the enhanced prompt and suggested size as snake_case JSON', async () => {
    enhancerReplies('{"prompt":"A vertical phone wallpaper of a neon Jakarta skyline at night","aspect_ratio":"9:16"}');
    const r = await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'wallpaper hp jakarta malam', style: 'neon' } }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      prompt: 'A vertical phone wallpaper of a neon Jakarta skyline at night',
      original: 'wallpaper hp jakarta malam',
      kind: 'image',
      aspect_ratio: '9:16',
      size: '1024x1792',
      enhanced: true,
      mode: 'text',
      references: [],
      model: expect.any(String),
      credits: expect.any(Number),
    });
  });

  it('suggests ratio and seconds for video', async () => {
    enhancerReplies('{"prompt":"Tracking shot of a motorbike","aspect_ratio":"9:16","seconds":6}');
    const r = await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'motor ngebut', kind: 'video' } }));
    expect(r.body).toMatchObject({ kind: 'video', ratio: '9:16', aspect_ratio: '9:16', seconds: 6, enhanced: true });
    expect(r.body.size).toBeUndefined();
  });

  it('validates the body', async () => {
    expect((await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: {} }))).body.error.code).toBe('validation_error');
    expect((await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: ' ' } }))).status).toBe(400);
    expect((await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'x', kind: 'audio' } }))).status).toBe(400);
    expect((await fetch(`${h.url}/api/v1/prompts/enhance`, { method: 'POST' })).status).toBe(401);
  });

  it('respects the monthly credit limit', async () => {
    const setLimit = (limit: number | null) =>
      h.api(`/api/v1/admin/users/${h.userId}`, { method: 'PATCH', key: h.admin.apiKey, json: { monthly_credit_limit: limit } });
    expect((await setLimit(0)).status).toBe(200);
    try {
      const r = await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'kucing' } }));
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('credit_limit_exceeded');
    } finally {
      await setLimit(null);
    }
  });
});

describe('enhance: true on media jobs', () => {
  it('images: uses the enhanced prompt and its size unless a size was given', async () => {
    enhancerReplies('{"prompt":"Flat illustration poster of an orange cat","aspect_ratio":"3:4"}');
    const auto = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'poster kucing', enhance: true } }));
    expect(auto.body).toMatchObject({ status: 'completed', request: { prompt: 'Flat illustration poster of an orange cat', original_prompt: 'poster kucing', size: '768x1024', enhance: true } });

    const fixed = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'poster kucing', enhance: true, size: '1024x1024' } }));
    expect(fixed.body.request).toMatchObject({ prompt: 'Flat illustration poster of an orange cat', size: '1024x1024' });

    const plain = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'poster kucing' } }));
    expect(plain.body.request.prompt).toBe('poster kucing');
    expect(plain.body.request.original_prompt).toBeUndefined();
  });

  it('videos: ratio and seconds come from the enhancer only when not specified', async () => {
    enhancerReplies('{"prompt":"Slow orbit around a lighthouse at dusk","aspect_ratio":"9:16","seconds":8}');
    const a = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'mercusuar', enhance: true } }));
    expect(a.status).toBe(202);
    expect(a.body.request).toMatchObject({ prompt: 'Slow orbit around a lighthouse at dusk', original_prompt: 'mercusuar', ratio: '9:16', seconds: 8 });
    const b = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'mercusuar', enhance: true, ratio: '1:1', seconds: 4 } }));
    expect(b.body.request).toMatchObject({ prompt: 'Slow orbit around a lighthouse at dusk', ratio: '1:1', seconds: 4 });
    expect((await waitForJob(a.body.id)).status).toBe('completed');
    expect((await waitForJob(b.body.id)).status).toBe('completed');
  });
});

describe('image providers without Folax', () => {
  it('reports folax unavailable and rejects explicit provider folax', async () => {
    const models = await json(await h.api('/api/v1/models'));
    expect(models.body.default_image_provider).toBe('auto');
    expect(models.body.image_providers).toEqual([
      expect.objectContaining({ id: 'qoder', available: true }),
      expect.objectContaining({ id: 'folax', available: false }),
    ]);
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x', provider: 'folax' } }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('provider_unavailable');
    const auto = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'kucing', provider: 'auto' } }));
    expect(auto.body.request).toMatchObject({ provider: 'auto', provider_used: 'qoder' });
    const list = await json(await h.api('/v1/models'));
    expect(list.body.data.map((m: any) => m.id)).not.toContain('folax-image');
  });
});
