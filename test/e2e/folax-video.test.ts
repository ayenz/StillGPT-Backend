import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mediaJobs } from '../../src/db/schema.js';
import { FAKE_MP4, type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Folax image-to-video: POST /videos provider folax (and OpenAI folax-video), polling, adapter/StillGPT restarts. */

let folax: FakeFolax;
let h: Harness;
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key, MEDIA_POLL_INTERVAL_MS: '50', FOLAX_VIDEO_POLL_MS: '20' } });
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const createVideo = async (payload: Record<string, unknown>) => json(await h.api('/api/v1/videos', { method: 'POST', json: payload }));
const getJob = async (id: string) => (await json(await h.api(`/api/v1/jobs/${id}`))).body;
const submits = () => folax.callsTo('POST /v1/videos');

async function upload(bytes: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'in.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const finished = (id: string) => waitFor(() => getJob(id), (j) => j.status === 'completed' || j.status === 'failed');

describe('POST /videos provider folax', () => {
  it('animates the first frame, stores the mp4 and fixes the output options', async () => {
    const png = makePng();
    const frame = await upload(png);
    const r = await createVideo({ prompt: 'angin sepoi, kamera maju pelan', first_frame_file_id: frame.id, provider: 'folax', seconds: 10, resolution: '1080P', audio: true });
    expect(r.status).toBe(202);
    expect(r.body.request).toMatchObject({ provider: 'folax', provider_used: 'folax', mode: 'first_frame_to_video', seconds: 5, resolution: '720P', ratio: 'adaptive', audio: false });

    const done = await finished(r.body.id);
    expect(done).toMatchObject({ status: 'completed', credits: 0, progress: 100, request: { folax: { id: 'video_1', task_id: 'cgt-1', client_task_id: 'ct-1' } } });
    expect(done.outputs).toHaveLength(1);
    expect(done.outputs[0].mime_type).toBe('video/mp4');
    expect(Buffer.from(await (await fetch(done.outputs[0].url)).arrayBuffer())).toEqual(FAKE_MP4);

    expect(submits()).toHaveLength(1);
    expect(submits()[0]!.headers['idempotency-key']).toBe(r.body.id);
    expect(submits()[0]!.body).toEqual({ image: png.toString('base64'), prompt: 'angin sepoi, kamera maju pelan' });
    expect(folax.callsTo('GET /v1/videos/video_1/content')).toHaveLength(1);
  });

  it('requires a first frame and refuses Qoder-only inputs', async () => {
    const frame = await upload(makePng());
    const none = await createVideo({ prompt: 'x', provider: 'folax' });
    expect(none).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } });
    expect((await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id, last_frame_file_id: frame.id })).status).toBe(400);
    expect((await createVideo({ prompt: 'x', provider: 'folax', reference_file_ids: [frame.id] })).status).toBe(400);
    expect((await createVideo({ prompt: 'x', provider: 'sora', first_frame_file_id: frame.id })).status).toBe(400);
    expect(submits()).toHaveLength(0);
  });

  it('an upstream failure fails the job (no Qoder fallback)', async () => {
    const frame = await upload(makePng());
    const sessions = h.qoder.state.sessions.size;
    folax.state.videoFail = { code: 'upstream_task_failed', message: 'Video generation failed' };
    const r = await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id });
    expect(await finished(r.body.id)).toMatchObject({ status: 'failed', outputs: [], error: { code: 'folax_failed', message: 'Folax: Video generation failed' } });
    expect(h.qoder.state.sessions.size).toBe(sessions);
  });

  it('a used-up quota fails at submit without retrying', async () => {
    const frame = await upload(makePng());
    folax.failNext('POST /v1/videos', 429, 'quota_exceeded', { 'Retry-After': '86400' });
    const r = await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id });
    expect(await finished(r.body.id)).toMatchObject({ status: 'failed', error: { code: 'folax_quota_exceeded' } });
    expect(submits()).toHaveLength(1);
  });

  it('waits and retries while the adapter is busy (too_many_jobs)', async () => {
    const frame = await upload(makePng());
    folax.failNext('POST /v1/videos', 429, 'too_many_jobs', { 'Retry-After': '30' });
    const r = await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id });
    expect(await finished(r.body.id)).toMatchObject({ status: 'completed' });
    expect(submits().map((c) => c.headers['idempotency-key'])).toEqual([r.body.id, r.body.id]);
  });

  it('resumes the upstream task when the adapter restarted and forgot the job', async () => {
    const frame = await upload(makePng());
    folax.state.videoPolls = 6;
    const r = await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id });
    await waitFor(() => folax.callsTo('GET /v1/videos/video_1'), (c) => c.length >= 2);
    folax.restart();
    const done = await finished(r.body.id);
    expect(done).toMatchObject({ status: 'completed', request: { folax: { task_id: 'cgt-1' } } });
    expect(done.request.folax.id).not.toBe('video_1');
    expect(folax.callsTo('POST /v1/videos/resume')[0]!.body).toEqual({ task_id: 'cgt-1', client_task_id: 'ct-1' });
    expect(submits()).toHaveLength(1);
  });

  it('a StillGPT restart keeps the job running and polls the same adapter job', async () => {
    const frame = await upload(makePng());
    folax.state.videoPolls = 8;
    const r = await createVideo({ prompt: 'x', provider: 'folax', first_frame_file_id: frame.id });
    await waitFor(() => folax.callsTo('GET /v1/videos/video_1'), (c) => c.length >= 1);
    await h.ctx.media.stop();
    await new Promise((res) => setTimeout(res, 150));
    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, r.body.id));
    expect(row!.status).toBe('in_progress');
    h.ctx.media.start();
    expect(await finished(r.body.id)).toMatchObject({ status: 'completed', request: { folax: { id: 'video_1' } } });
    expect(submits()).toHaveLength(1);
  });
});

describe('OpenAI /v1/videos with folax-video', () => {
  it('uses input_reference as the first frame', async () => {
    const form = new FormData();
    form.append('model', 'folax-video');
    form.append('prompt', 'ombak bergerak');
    form.append('seconds', '8');
    form.append('input_reference', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'frame.png');
    const r = await json(await h.api('/v1/videos', { method: 'POST', body: form }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: 'video', model: 'folax-video', seconds: '5' });
    await finished(r.body.id);
    const content = await h.api(`/v1/videos/${r.body.id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(FAKE_MP4);
  });
});

describe('GET /models', () => {
  it('lists the video providers', async () => {
    const r = await json(await h.api('/api/v1/models'));
    expect(r.body.default_video_provider).toBe('qoder');
    expect(r.body.video_providers).toEqual([
      expect.objectContaining({ id: 'qoder', available: true }),
      expect.objectContaining({ id: 'folax', available: true, modes: ['first_frame_to_video'], seconds: 5, resolution: '720P', watermark: true }),
    ]);
    const models = await json(await h.api('/v1/models'));
    expect(models.body.data.map((m: any) => m.id)).toContain('folax-video');
  });
});
