import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mediaJobs } from '../../src/db/schema.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Image jobs Qoder could not make (down, out of credits…) are finished by Folax. */

let folax: FakeFolax;
let h: Harness;
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key, MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterEach(() => {
  folax.reset();
  h.qoder.setToolError(undefined);
});
afterAll(async () => {
  await h?.close();
  await folax?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const createImage = async (payload: Record<string, unknown>) => json(await h.api('/api/v1/images', { method: 'POST', json: payload }));
const edits = () => folax.callsTo('POST /v1/images/edits');
const generates = () => folax.callsTo('POST /v1/images/generate-all');
const qoderDown = () => h.qoder.setToolError(() => 'image_gen error: billing_error You have no available credit.');

async function upload() {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'in.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

describe('Qoder → Folax fallback for image jobs', () => {
  it('text-to-image on Qoder: Folax generates it, the job records why', async () => {
    qoderDown();
    const r = await createImage({ prompt: 'kucing oren di atas laptop', provider: 'qoder' });
    expect(r.body).toMatchObject({
      status: 'completed',
      request: { provider: 'qoder', provider_used: 'folax', qoder_fallback: 'folax', fallback_reason: 'generation_failed', qoder_error: { code: 'generation_failed' } },
    });
    expect(r.body.outputs).toHaveLength(2);
    expect(generates()).toHaveLength(1);
  });

  it('an edit of one image: a Folax prompt edit, keyed by the job id', async () => {
    qoderDown();
    const input = await upload();
    const r = await createImage({ prompt: 'ganti background jadi pantai', input_file_ids: [input.id] });
    expect(r.body).toMatchObject({ status: 'completed', request: { provider_used: 'folax', qoder_fallback: 'folax_edit', folax_edit: { mode: 'instruction' } } });
    expect(r.body.outputs).toHaveLength(1);
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.headers['idempotency-key']).toBe(r.body.id);
    expect(edits()[0]!.body).toMatchObject({ mode: 'instruction', prompt: 'ganti background jadi pantai' });
  });

  it('no fallback for edits that combine several images, nor when Qoder works', async () => {
    qoderDown();
    const [a, b] = [await upload(), await upload()];
    const r = await createImage({ prompt: 'gabungkan', input_file_ids: [a.id, b.id] });
    expect(r.body).toMatchObject({ status: 'failed', error: { code: 'generation_failed' } });
    expect(r.body.request.qoder_fallback).toBeUndefined();

    h.qoder.setToolError(undefined);
    const ok = await createImage({ prompt: 'edit', input_file_ids: [a.id] });
    expect(ok.body).toMatchObject({ status: 'completed', request: { provider_used: 'qoder' } });
    expect(edits()).toHaveLength(0);
  });

  it('when Folax fails too, the error names both', async () => {
    qoderDown();
    folax.failNext('POST /v1/images/edits', 429, 'quota_exceeded');
    const input = await upload();
    const r = await createImage({ prompt: 'ganti baju', input_file_ids: [input.id] });
    expect(r.body.status).toBe('failed');
    expect(r.body.error.code).toBe('folax_quota_exceeded');
    expect(r.body.error.message).toMatch(/Qoder failed \(generation_failed\) and the folax_edit fallback failed too/);
  });

  it('a job switched to the fallback before a restart continues there without a new Qoder turn', async () => {
    const input = await upload();
    const sessions = h.qoder.state.sessions.size;
    const request = { prompt: 'ganti langit', size: '1024x1024', input_file_ids: [input.id], provider: 'auto', provider_used: 'folax', qoder_fallback: 'folax_edit', folax_edit: { mode: 'instruction' }, fallback_reason: 'billing_error' };
    const id = `img_fb${Date.now()}`;
    await h.ctx.database.db.insert(mediaJobs).values({ id, userId: h.userId, kind: 'image', request });
    await (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();
    for (let i = 0; i < 200; i++) {
      const j = await json(await h.api(`/api/v1/jobs/${id}`));
      if (j.body.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await json(await h.api(`/api/v1/jobs/${id}`))).body.status).toBe('completed');
    expect(edits()[0]!.headers['idempotency-key']).toBe(id);
    expect(h.qoder.state.sessions.size).toBe(sessions);
  });
});
