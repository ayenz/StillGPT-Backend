import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const IMAGE_MS = 400;
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ mock: { imageDelayMs: IMAGE_MS }, env: { MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const post = (payload: unknown) => h.api('/api/v1/images', { method: 'POST', json: payload });

/** Fail the k-th ImageGen call (1-based) from now on, succeed the others. */
function failCall(k: number) {
  let calls = 0;
  h.qoder.setToolError((tool) => (tool === 'ImageGen' && ++calls === k ? 'image_gen error: content policy' : undefined));
}

describe('image batches (native)', () => {
  it('runs n images in parallel as one batch (sync)', async () => {
    const t0 = Date.now();
    const r = await json(await post({ prompt: 'kucing astronot', n: 4, size: '1024x1536' }));
    const took = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', n: 4, completed: 4, failed: 0, progress: 100 });
    expect(r.body.id).toMatch(/^batch_/);
    expect(r.body.jobs).toHaveLength(4);
    for (const [i, j] of r.body.jobs.entries()) {
      expect(j).toMatchObject({ kind: 'image', status: 'completed', batch_id: r.body.id, request: { prompt: 'kucing astronot', size: '1024x1536', n: 4, batch_index: i, provider_used: 'qoder' } });
      expect(j.outputs).toHaveLength(1);
    }
    expect(new Set(r.body.jobs.flatMap((j: any) => j.outputs.map((o: any) => o.id))).size).toBe(4);
    expect(r.body.credits).toBeCloseTo(r.body.jobs.reduce((s: number, j: any) => s + j.credits, 0));
    expect(took).toBeLessThan(IMAGE_MS * 4); // parallel, not one after another
  });

  it('async: 202 with the batch, observable via GET, SSE and /jobs?batch_id', async () => {
    const r = await json(await post({ prompt: 'pemandangan gunung', n: 3, async: true }));
    expect(r.status).toBe(202);
    expect(['queued', 'in_progress']).toContain(r.body.status);
    expect(r.body.jobs).toHaveLength(3);

    const events = await readSse(await h.api(`/api/v1/images/batches/${r.body.id}/events`));
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('batch');
    expect(names.filter((n) => n === 'job.completed')).toHaveLength(3);
    expect(names.at(-1)).toBe('batch.done');
    expect(events.at(-1)!.data).toMatchObject({ id: r.body.id, status: 'completed', completed: 3, progress: 100 });
    const progress = events.filter((e) => e.event === 'progress');
    if (progress.length) expect(progress[0]!.data).toHaveProperty('batch_progress');

    const got = await json(await h.api(`/api/v1/images/batches/${r.body.id}`));
    expect(got.body).toMatchObject({ status: 'completed', completed: 3 });
    expect(got.body.jobs.map((j: any) => j.id)).toEqual(r.body.jobs.map((j: any) => j.id));
    const listed = await json(await h.api(`/api/v1/jobs?batch_id=${r.body.id}`));
    expect(listed.body.data.map((j: any) => j.id).sort()).toEqual(r.body.jobs.map((j: any) => j.id).sort());

    // finished batch: snapshot + done
    const again = await readSse(await h.api(`/api/v1/images/batches/${r.body.id}/events`));
    expect(again.map((e) => e.event)).toEqual(['batch', 'batch.done']);
  });

  it('one failed image makes the batch partial; the others still deliver', async () => {
    failCall(2);
    const r = await json(await post({ prompt: 'bunga', n: 3 }));
    h.qoder.setToolError(undefined);
    expect(r.body).toMatchObject({ status: 'partial', completed: 2, failed: 1 });
    const failed = r.body.jobs.filter((j: any) => j.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error.code).toBe('generation_failed');
  });

  it('enhances the prompt once for the whole batch', async () => {
    let enhancerCalls = 0;
    h.qoder.setReply((text) => (text.includes('<idea>') ? (enhancerCalls++, '{"prompt":"A cinematic red fox in fresh snow","aspect_ratio":"1:1"}') : undefined));
    const r = await json(await post({ prompt: 'rubah', n: 3, enhance: true }));
    h.qoder.setReply(undefined);
    expect(enhancerCalls).toBe(1);
    for (const j of r.body.jobs) expect(j.request).toMatchObject({ prompt: 'A cinematic red fox in fresh snow', original_prompt: 'rubah' });
  });

  it('validates n and the provider', async () => {
    const bad = async (payload: unknown) => {
      const r = await json(await post(payload));
      expect(r.status, JSON.stringify(payload)).toBe(400);
      return r.body.error;
    };
    expect((await bad({ prompt: 'x', n: 0 })).message).toContain('between 1 and 6');
    expect((await bad({ prompt: 'x', n: 7 })).message).toContain('between 1 and 6');
    expect((await bad({ prompt: 'x', n: 2.5 })).code).toBe('validation_error');
    expect((await bad({ prompt: 'x', n: '3' })).code).toBe('validation_error');
    expect((await bad({ prompt: 'x', n: 2, provider: 'folax' })).message).toContain('qoder');
    expect((await h.api('/api/v1/images/batches/batch_nope')).status).toBe(404);
  });

  it('n = 1 is a batch of one; omitting n keeps the single-job response', async () => {
    const one = await json(await post({ prompt: 'satu', n: 1 }));
    expect(one.body).toMatchObject({ n: 1, status: 'completed' });
    const single = await json(await post({ prompt: 'satu' }));
    expect(single.body).toMatchObject({ kind: 'image', status: 'completed', batch_id: null });
  });

  it('batches are per user', async () => {
    const r = await json(await post({ prompt: 'privat', n: 2 }));
    const other = await h.api(`/api/v1/images/batches/${r.body.id}`, { key: h.admin.apiKey });
    expect(other.status).toBe(404);
  });
});

describe('image batches (OpenAI n)', () => {
  it('runs n Qoder images in parallel and returns them all', async () => {
    const client = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1` });
    const t0 = Date.now();
    const res = await client.images.generate({ model: 'qoder-image', prompt: 'robot', n: 6 });
    expect(res.data).toHaveLength(6);
    expect(Date.now() - t0).toBeLessThan(IMAGE_MS * 4);
  });

  it('returns the images that succeeded when some fail', async () => {
    failCall(1);
    const res = await json(await h.api('/v1/images/generations', { method: 'POST', json: { model: 'qoder-image', prompt: 'x', n: 3 } }));
    h.qoder.setToolError(undefined);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});
