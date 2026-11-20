import OpenAI, { toFile } from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { FolaxClient } from '../../src/providers/folax.js';
import { FAKE_JPEG, type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Folax edits: prompt edit via POST /images (provider folax + 1 input). */

let folax: FakeFolax;
let h: Harness;
let client: OpenAI;
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key, MEDIA_POLL_INTERVAL_MS: '50' } });
  client = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1`, maxRetries: 0 });
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const createImage = async (payload: Record<string, unknown>) => json(await h.api('/api/v1/images', { method: 'POST', json: payload }));
const edits = () => folax.callsTo('POST /v1/images/edits');

async function upload(bytes: Buffer, key?: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'in.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form, key })).json()) as { id: string };
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Folax prompt edit (POST /images, provider folax)', () => {
  it('edits the one input image with the prompt, keyed by the job id, free', async () => {
    const png = makePng();
    const input = await upload(png);
    const sessions = h.qoder.state.sessions.size;
    const r = await createImage({ prompt: 'ganti langit jadi senja', input_file_ids: [input.id], provider: 'folax' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'completed',
      credits: 0,
      request: { provider: 'folax', provider_used: 'folax', folax_edit: { mode: 'instruction' }, input_file_ids: [input.id] },
    });
    expect(r.body.outputs).toHaveLength(1);
    expect(r.body.outputs[0].mime_type).toBe('image/jpeg');
    const out = await fetch(r.body.outputs[0].url);
    expect(Buffer.from(await out.arrayBuffer())).toEqual(FAKE_JPEG);

    expect(edits()).toHaveLength(1);
    const call = edits()[0]!;
    expect(call.headers['idempotency-key']).toBe(r.body.id);
    expect(call.body).toEqual({ mode: 'instruction', prompt: 'ganti langit jadi senja', image: png.toString('base64') });
    expect(h.qoder.state.sessions.size).toBe(sessions);
  });

  it('rejects batches and more than one input', async () => {
    const a = await upload(makePng());
    const b = await upload(makePng());
    const batch = await createImage({ prompt: 'x', input_file_ids: [a.id], provider: 'folax', n: 2 });
    expect(batch).toMatchObject({ status: 400, body: { error: { code: 'validation_error', details: { param: 'n' } } } });
    const two = await createImage({ prompt: 'x', input_file_ids: [a.id, b.id], provider: 'folax' });
    expect(two.status).toBe(400);
    expect(edits()).toHaveLength(0);
  });

  it('a used-up quota fails the job without falling back to Qoder', async () => {
    const input = await upload(makePng());
    const sessions = h.qoder.state.sessions.size;
    folax.failNext('POST /v1/images/edits', 429, 'quota_exceeded', { 'Retry-After': '3600' });
    const r = await createImage({ prompt: 'tambah topi', input_file_ids: [input.id], provider: 'folax' });
    expect(r.body).toMatchObject({ status: 'failed', outputs: [], error: { code: 'folax_quota_exceeded' } });
    expect(h.qoder.state.sessions.size).toBe(sessions);
  });

  it('a content rejection fails the job with the adapter message', async () => {
    const input = await upload(makePng());
    folax.failNext('POST /v1/images/edits', 422, 'content_rejected', undefined, 'konten ditolak');
    const r = await createImage({ prompt: 'x', input_file_ids: [input.id], provider: 'folax' });
    expect(r.body).toMatchObject({ status: 'failed', error: { code: 'content_rejected', message: 'konten ditolak' } });
  });

  it('OpenAI /images/edits with folax-image edits one image; n > 1 is rejected', async () => {
    const res = await client.images.edit({ model: 'folax-image', prompt: 'jadikan hitam putih', image: await toFile(makePng(), 'in.png', { type: 'image/png' }), response_format: 'b64_json' });
    expect(res.data).toHaveLength(1);
    expect(Buffer.from(res.data![0]!.b64_json!, 'base64')).toEqual(FAKE_JPEG);
    expect(edits()[0]!.body).toMatchObject({ mode: 'instruction', prompt: 'jadikan hitam putih' });

    await expect(
      client.images.edit({ model: 'folax-image', prompt: 'x', n: 2, image: await toFile(makePng(), 'in.png', { type: 'image/png' }) }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_n' });

    folax.failNext('POST /v1/images/edits', 429, 'quota_exceeded');
    await expect(
      client.images.edit({ model: 'folax-image', prompt: 'x', image: await toFile(makePng(), 'in.png', { type: 'image/png' }) }),
    ).rejects.toMatchObject({ status: 429, code: 'folax_quota_exceeded' });
  });
});

describe('POST /images/:fileId/remove-people', () => {
  it('is gone (the feature was removed)', async () => {
    const input = await upload(makePng());
    const r = await json(await h.api(`/api/v1/images/${input.id}/remove-people`, { method: 'POST', json: {} }));
    expect(r.status).toBe(404);
    expect(edits()).toHaveLength(0);
  });
});

describe('FolaxClient.edit', () => {
  it('retries once with the same Idempotency-Key when our side times out', async () => {
    const c = new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger, timeoutMs: 150 });
    folax.state.editDelayMs = 400;
    const r = await c.edit({ mode: 'instruction', prompt: 'x', image: makePng(), idempotencyKey: 'img_retry1' });
    expect(r.mimeType).toBe('image/jpeg');
    expect(edits().map((x) => x.headers['idempotency-key'])).toEqual(['img_retry1', 'img_retry1']);
  });

  it('marks the replayed flag', async () => {
    const c = new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger });
    const first = await c.edit({ mode: 'instruction', prompt: 'x', image: makePng(), idempotencyKey: 'img_same' });
    const again = await c.edit({ mode: 'instruction', prompt: 'x', image: makePng(), idempotencyKey: 'img_same' });
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(folax.state.editsDone).toBe(1);
  });
});

// last: leaves the harness's Folax client marked down for its cache window
describe('Folax down', () => {
  it('a rejected token fails the edit, and later Folax requests are refused up front', async () => {
    const input = await upload(makePng());
    folax.failNext('POST /v1/images/edits', 502, 'auth_invalid');
    const r = await createImage({ prompt: 'x', input_file_ids: [input.id], provider: 'folax' });
    expect(r.body).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });

    const edit = await createImage({ prompt: 'x', input_file_ids: [input.id], provider: 'folax' });
    expect(edit.status).toBe(503);
    expect(edits()).toHaveLength(1);
    // text-to-image under auto keeps its own (generate-all) flow
  });
});
