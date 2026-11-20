import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FACE_SWAP_SETTINGS, FACE_SWAP_CROP_PROMPT, FACE_SWAP_POLISH_PROMPT, FACE_SWAP_PROMPT } from '../../src/core/faceSwap.js';
import { largestImageSize } from '../../src/core/media.js';
import { conversations, kv, mediaJobs, usageEvents } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const KEY = 'faceswap-test-key';
const SWAPPED = makePng(5, 5, [1, 2, 3]);
const PASTED = makePng(6, 6, [4, 5, 6]);
const CROP = makePng(8, 8, [7, 8, 9]);
const BOX = [10, 20, 300, 300];

interface Call {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/**
 * Fake faceswap sidecar: /health/ready, /v1/swap, /v1/face-crop, /v1/face-paste; `failNext` scripts error replies,
 * `misalignNext(n)` makes the next n pastes 422 PATCH_MISALIGNED.
 */
async function startFakeSidecar() {
  const calls: Call[] = [];
  const failures: { path: string; status: number; detail: string }[] = [];
  let ready = true;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-api-key'] !== KEY) return reply(401, { detail: 'AUTH_INVALID' });
      if (req.method === 'GET' && req.url === '/health/ready')
        return ready
          ? reply(200, { ready: true, models: { detector: 'scrfd', swapper: 'inswapper_128', restorers: ['codeformer', 'gfpgan'] }, version: '1.0.0' })
          : reply(503, { ready: false });
      const path = req.url ?? '';
      calls.push({ path, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const i = failures.findIndex((f) => f.path === path);
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        return reply(f!.status, { detail: f!.detail });
      }
      if (path === '/v1/swap')
        return reply(200, { image: SWAPPED.toString('base64'), mime_type: 'image/png', width: 5, height: 5, target_faces: 1, source_faces: 1, timings_ms: { swap: 12 } });
      if (path === '/v1/face-crop') return reply(200, { crop: CROP.toString('base64'), box: BOX, faces: 1 });
      if (path === '/v1/face-paste')
        return reply(200, { image: PASTED.toString('base64'), mime_type: 'image/png', width: 6, height: 6, alignment: { scale: 1.01, rotation_deg: 0.5, shift: 0.01 } });
      reply(404, { detail: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    setReady: (v: boolean) => (ready = v),
    failNext: (path: string, status: number, detail: string) => failures.push({ path, status, detail }),
    misalignNext(n: number) {
      for (let i = 0; i < n; i++) failures.push({ path: '/v1/face-paste', status: 422, detail: 'PATCH_MISALIGNED' });
    },
    reset() {
      calls.length = 0;
      failures.length = 0;
      ready = true;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let h: Harness;
let sidecar: Awaited<ReturnType<typeof startFakeSidecar>>;
beforeAll(async () => {
  sidecar = await startFakeSidecar();
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: sidecar.url, FACESWAP_API_KEY: KEY } });
});
afterAll(async () => {
  await h?.close();
  await sidecar?.close();
});
beforeEach(async () => {
  sidecar.reset();
  await h.ctx.faceswap!.readiness(true);
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function upload(filename: string, bytes: Buffer, key?: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form, key })).json()) as { id: string };
}

async function setup(opts: { w?: number; hgt?: number; key?: string } = {}) {
  const targetBytes = makePng(opts.w ?? 30, opts.hgt ?? 40);
  const faceBytes = makePng(4, 4, [9, 9, 9]);
  const target = await upload('target.png', targetBytes, opts.key);
  const faceFile = await upload('face.png', faceBytes, opts.key);
  const face = (await json(await h.api('/api/v1/faces', { method: 'POST', json: { name: 'Andi', file_id: faceFile.id }, key: opts.key }))).body;
  return { target, faceFile, face, targetBytes, faceBytes };
}

const swap = (fileId: string, payload: unknown) => h.api(`/api/v1/images/${fileId}/face-swap`, { method: 'POST', json: payload });
const finished = async (batchId: string) => {
  await readSse(await h.api(`/api/v1/images/batches/${batchId}/events`));
  return (await json(await h.api(`/api/v1/images/batches/${batchId}`))).body;
};
const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin/face-swap${path}`, { ...init, key: h.admin.apiKey });

describe('largestImageSize', () => {
  it('prefers the largest size among near-identical aspect ratios', () => {
    expect(largestImageSize(3000, 4000)).toBe('1024x1280');
    expect(largestImageSize(768, 1024)).toBe('1024x1280');
    expect(largestImageSize(1000, 1000)).toBe('1024x1024');
    expect(largestImageSize(3000, 2000)).toBe('1536x1024');
    expect(largestImageSize(1080, 1920)).toBe('1024x1792');
    expect(largestImageSize(2560, 1080)).toBe('2560x1080');
    expect(largestImageSize(4000, 3000)).toBe('1280x1024');
    expect(largestImageSize(undefined, 5)).toBe('1024x1024');
  });
});

describe('GET /face-swap/config', () => {
  it('reports the default engine, availability and max_n', async () => {
    const r = await json(await h.api('/api/v1/face-swap/config'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      default_engine: 'swapper_polish',
      engines: { swapper_polish: { available: true }, swapper: { available: true }, qoder: { available: true }, qoder_crop: { available: true } },
      max_n: 4,
    });
  });

  it('marks sidecar engines unavailable while the sidecar is not ready; POST then refuses them', async () => {
    sidecar.setReady(false);
    await h.ctx.faceswap!.readiness(true);
    const r = await json(await h.api('/api/v1/face-swap/config'));
    expect(r.body.engines).toEqual({ swapper_polish: { available: false }, swapper: { available: false }, qoder: { available: true }, qoder_crop: { available: false } });

    const { target, face } = await setup();
    // no engine given: the unavailable default (swapper_polish) falls back to whole-image qoder
    const def = await json(await swap(target.id, { face_id: face.id }));
    expect(def.status).toBe(202);
    expect(def.body.jobs[0].request.face_swap.engine).toBe('qoder');
    await finished(def.body.id);
    expect((await json(await swap(target.id, { face_id: face.id, engine: 'swapper' }))).body.error.code).toBe('engine_unavailable');
    expect((await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }))).body.error.code).toBe('engine_unavailable');
    expect((await json(await swap(target.id, { face_id: face.id, engine: 'swapper_polish' }))).body.error.code).toBe('engine_unavailable');
    const q = await json(await swap(target.id, { face_id: face.id, engine: 'qoder' }));
    expect(q.status).toBe(202);
    await finished(q.body.id);
    sidecar.setReady(true);
  });
});

describe('face swap engines', () => {
  it('swapper: one free job, n forced to 1, output saved from the sidecar', async () => {
    const { target, faceFile, face, targetBytes, faceBytes } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, engine: 'swapper', n: 3 }));
    expect(r.status).toBe(202);
    expect(r.body.n).toBe(1);
    expect(r.body.jobs[0].request).toMatchObject({
      provider: 'faceswap',
      provider_used: 'faceswap',
      input_file_ids: [target.id, faceFile.id],
      face_swap: { source_file_id: target.id, face_id: face.id, face_name: 'Andi', engine: 'swapper', face_file_id: faceFile.id, options: DEFAULT_FACE_SWAP_SETTINGS.swapper },
    });

    const b = await finished(r.body.id);
    expect(b.status).toBe('completed');
    const job = b.jobs[0];
    expect(job.credits).toBe(0);
    expect(job.outputs).toHaveLength(1);
    expect(job.outputs[0]).toMatchObject({ mime_type: 'image/png', kind: 'image' });
    expect((await download(job.outputs[0].url)).equals(SWAPPED)).toBe(true);

    const call = sidecar.calls.find((c) => c.path === '/v1/swap')!;
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(Buffer.from(call.body.target, 'base64').equals(targetBytes)).toBe(true);
    expect(call.body.sources.map((s: string) => Buffer.from(s, 'base64').equals(faceBytes))).toEqual([true]);
    expect(call.body.options).toEqual(DEFAULT_FACE_SWAP_SETTINGS.swapper);
    // no Qoder turn
    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, job.id));
    expect(row!.qoderSessionId).toBeNull();
    const usage = await h.ctx.database.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'faceswap', kind: 'image' });
  });

  it('swapper: sidecar errors fail the job with a clear code', async () => {
    const { target, face } = await setup();
    sidecar.failNext('/v1/swap', 422, 'NO_FACE_IN_TARGET');
    const a = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper' }))).body.id);
    expect(a.status).toBe('failed');
    expect(a.jobs[0].error.code).toBe('no_face_in_target');

    sidecar.failNext('/v1/swap', 422, 'NO_FACE_IN_SOURCE');
    const b = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper' }))).body.id);
    expect(b.jobs[0].error.code).toBe('no_face_in_source');

    sidecar.failNext('/v1/swap', 500, 'boom');
    const c = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper' }))).body.id);
    expect(c.jobs[0].error.code).toBe('faceswap_failed');
  });

  it('qoder: whole-photo Qoder edit with the settings prompt at the largest size of the target ratio', async () => {
    const { target, faceFile, face } = await setup({ w: 30, hgt: 40 });
    const r = await json(await swap(target.id, { face_id: face.id, engine: 'qoder', n: 2 }));
    expect(r.body.n).toBe(2);
    expect(r.body.jobs[0].request).toMatchObject({
      prompt: FACE_SWAP_PROMPT,
      size: '1024x1280',
      provider_used: 'qoder',
      input_file_ids: [target.id, faceFile.id],
      face_swap: { engine: 'qoder' },
    });
    const b = await finished(r.body.id);
    expect(b.status).toBe('completed');
    expect(sidecar.calls).toEqual([]);
  });

  it('qoder_crop: crop → Qoder edit of [crop, face] at 1024x1024 → paste into the original; only the pasted photo is an output', async () => {
    const { target, faceFile, face, targetBytes } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }));
    expect(r.status).toBe(202);
    expect(r.body.jobs[0].request).toMatchObject({ prompt: FACE_SWAP_CROP_PROMPT, size: '1024x1024', face_swap: { engine: 'qoder_crop', crop_expand: 2.2 } });
    const b = await finished(r.body.id);
    expect(b.status).toBe('completed');
    const job = b.jobs[0];

    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/face-crop', '/v1/face-paste']);
    const [crop, paste] = sidecar.calls;
    expect(Buffer.from(crop!.body.image, 'base64').equals(targetBytes)).toBe(true);
    expect(crop!.body).toMatchObject({ expand: 2.2, det_thresh: 0.5, size: 1024 });
    expect(Buffer.from(paste!.body.base, 'base64').equals(targetBytes)).toBe(true);
    expect(Buffer.from(paste!.body.patch, 'base64').equals(makePng())).toBe(true); // the mock Qoder's edit
    expect(paste!.body.box).toEqual(BOX);

    const fs = job.request.face_swap;
    expect(fs).toMatchObject({ crop_box: BOX, source_file_id: target.id, attempts: 1 });
    expect(fs.swapped_file_id).toBeUndefined();
    expect(job.request.input_file_ids).toEqual([fs.crop_file_id, faceFile.id]);
    expect(job.outputs).toHaveLength(1);
    expect(job.outputs[0].id).not.toBe(fs.qoder_output_file_id);
    expect(job.outputs[0].id).not.toBe(fs.crop_file_id);
    expect((await download(job.outputs[0].url)).equals(PASTED)).toBe(true);
    expect(job.credits).toBeGreaterThan(0);

    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, job.id));
    const s = h.qoder.state.sessions.get(row!.qoderSessionId!)!;
    expect(s.resources.map((x) => x.mount_path)).toEqual(['/data/attachments/face-crop.png', '/data/attachments/face.png']);
    expect((await h.ctx.store.read(await h.ctx.store.get(fs.crop_file_id))).equals(CROP)).toBe(true);
  });

  it('qoder_crop: no face in the target fails before any Qoder turn; a failed paste fails the job', async () => {
    const { target, face } = await setup();
    sidecar.failNext('/v1/face-crop', 422, 'NO_FACE_IN_TARGET');
    const a = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }))).body.id);
    expect(a.jobs[0].error.code).toBe('no_face_in_target');
    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, a.jobs[0].id));
    expect(row!.qoderSessionId).toBeNull();

    sidecar.reset();
    sidecar.failNext('/v1/face-paste', 500, 'oops');
    const b = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }))).body.id);
    expect(b.status).toBe('failed');
    expect(b.jobs[0].error.code).toBe('faceswap_failed');
    expect(b.jobs[0].outputs).toEqual([]);
  });

  it('qoder_crop: a job picked up again after a restart reuses its crop and still pastes', async () => {
    const { target, face } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }));
    const first = (await finished(r.body.id)).jobs[0];
    // a copy of that job, left queued by a "restart" right after the crop step
    const fs = { ...first.request.face_swap };
    delete fs.qoder_output_file_id;
    const [copy] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({ id: `img_resume${Date.now()}`, userId: h.userId, kind: 'image', request: { ...first.request, face_swap: fs }, batchId: `batch_resume${Date.now()}` })
      .returning();
    sidecar.reset();
    await (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();
    const done = await finished(copy!.batchId!);
    expect(done.status).toBe('completed');
    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/face-paste']);
    expect(done.jobs[0].request.face_swap.crop_file_id).toBe(fs.crop_file_id);
    expect((await download(done.jobs[0].outputs[0].url)).equals(PASTED)).toBe(true);
  });

  it('rejects an unknown engine', async () => {
    const { target, face } = await setup();
    expect((await json(await swap(target.id, { face_id: face.id, engine: 'magic' }))).status).toBe(400);
  });
});

const hiddenTurns = async (jobId: string) =>
  (await h.ctx.database.db.select().from(conversations).where(sql`${conversations.metadata}->>'job_id' = ${jobId}`)).length;
const usageOf = (jobId: string) => h.ctx.database.db.select().from(usageEvents).where(eq(usageEvents.jobId, jobId));
const qoderCredits = async (jobId: string) =>
  (await usageOf(jobId)).filter((u) => u.model !== 'faceswap').reduce((sum, u) => sum + u.creditsTotal, 0);

describe('swapper_polish and misaligned close-ups', () => {
  it('swapper_polish (default): swapper → crop of the swapped photo → Qoder polish → pasted onto the swapped photo', async () => {
    const { target, faceFile, face, targetBytes, faceBytes } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, n: 2 }));
    expect(r.status).toBe(202);
    expect(r.body.n).toBe(2);
    expect(r.body.jobs[0].request).toMatchObject({
      prompt: FACE_SWAP_POLISH_PROMPT,
      size: '1024x1024',
      provider_used: 'qoder',
      face_swap: { engine: 'swapper_polish', crop_expand: 2.2, options: DEFAULT_FACE_SWAP_SETTINGS.swapper, face_file_id: faceFile.id },
    });
    const b = await finished(r.body.id);
    expect(b.status).toBe('completed');
    // each job does its own swapper step
    expect(sidecar.calls.filter((c) => c.path === '/v1/swap')).toHaveLength(2);

    const job = b.jobs[0];
    const calls = sidecar.calls.filter((c) => [c.body?.target, c.body?.image, c.body?.base].some(Boolean));
    const swapCall = calls.find((c) => c.path === '/v1/swap')!;
    expect(Buffer.from(swapCall.body.target, 'base64').equals(targetBytes)).toBe(true);
    expect(Buffer.from(swapCall.body.sources[0], 'base64').equals(faceBytes)).toBe(true);
    for (const c of sidecar.calls.filter((x) => x.path === '/v1/face-crop')) {
      expect(Buffer.from(c.body.image, 'base64').equals(SWAPPED)).toBe(true);
      expect(c.body).toMatchObject({ expand: 2.2, det_thresh: 0.5, size: 1024 });
    }
    for (const c of sidecar.calls.filter((x) => x.path === '/v1/face-paste')) {
      expect(Buffer.from(c.body.base, 'base64').equals(SWAPPED)).toBe(true);
      expect(c.body.box).toEqual(BOX);
    }

    const fs = job.request.face_swap;
    expect(fs).toMatchObject({ attempts: 1, crop_box: BOX, alignment: { scale: 1.01, rotation_deg: 0.5, shift: 0.01 } });
    expect(fs.polish_failed).toBeUndefined();
    expect(fs.misaligned_file_ids).toBeUndefined();
    expect(job.request.input_file_ids).toEqual([fs.crop_file_id, faceFile.id]);
    expect(job.outputs).toHaveLength(1);
    const out = job.outputs[0].id;
    expect([fs.swapped_file_id, fs.crop_file_id, fs.qoder_output_file_id]).not.toContain(out);
    expect((await download(job.outputs[0].url)).equals(PASTED)).toBe(true);
    const swapped = await h.ctx.store.get(fs.swapped_file_id);
    expect(swapped).toMatchObject({ kind: 'upload', filename: 'face-swapped.png', jobId: job.id });
    expect((await h.ctx.store.read(swapped)).equals(SWAPPED)).toBe(true);
    expect((await h.ctx.store.read(await h.ctx.store.get(fs.crop_file_id))).equals(CROP)).toBe(true);

    // credits are the Qoder edit's; the swapper step is free usage
    expect(job.credits).toBeGreaterThan(0);
    expect(job.credits).toBeCloseTo(await qoderCredits(job.id), 6);
    expect((await usageOf(job.id)).filter((u) => u.model === 'faceswap')).toHaveLength(1);
    expect(await hiddenTurns(job.id)).toBe(1);
    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, job.id));
    const s = h.qoder.state.sessions.get(row!.qoderSessionId!)!;
    expect(s.resources.map((x) => x.mount_path)).toEqual(['/data/attachments/face-crop.png', '/data/attachments/face.png']);
  });

  it('swapper_polish: no face in the target fails in the swapper step before any Qoder turn', async () => {
    const { target, face } = await setup();
    sidecar.failNext('/v1/swap', 422, 'NO_FACE_IN_TARGET');
    const a = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper_polish' }))).body.id);
    expect(a.status).toBe('failed');
    expect(a.jobs[0].error.code).toBe('no_face_in_target');
    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/swap']);
    expect(await hiddenTurns(a.jobs[0].id)).toBe(0);
  });

  for (const engine of ['swapper_polish', 'qoder_crop'] as const) {
    it(`${engine}: a misaligned edit is redone in a new Qoder turn; credits add up`, async () => {
      const { target, face } = await setup();
      sidecar.misalignNext(1);
      const b = await finished((await json(await swap(target.id, { face_id: face.id, engine }))).body.id);
      expect(b.status).toBe('completed');
      const job = b.jobs[0];
      const fs = job.request.face_swap;
      expect(fs.attempts).toBe(2);
      expect(fs.misaligned_file_ids).toHaveLength(1);
      expect(fs.misaligned_file_ids[0]).not.toBe(fs.qoder_output_file_id);
      expect(fs.polish_failed).toBeUndefined();
      expect(sidecar.calls.filter((c) => c.path === '/v1/face-paste')).toHaveLength(2);
      expect(sidecar.calls.filter((c) => c.path === '/v1/face-crop')).toHaveLength(1);
      expect(await hiddenTurns(job.id)).toBe(2);
      expect(job.outputs).toHaveLength(1);
      expect((await download(job.outputs[0].url)).equals(PASTED)).toBe(true);
      const usage = (await usageOf(job.id)).filter((u) => u.model !== 'faceswap');
      expect(usage).toHaveLength(2);
      expect(job.credits).toBeCloseTo(await qoderCredits(job.id), 6);
      expect(job.credits).toBeCloseTo(usage[0]!.creditsTotal * 2, 6);
    });
  }

  it('swapper_polish: misaligned 3 times → completes with the plain swapper result and polish_failed', async () => {
    const { target, face } = await setup();
    sidecar.misalignNext(3);
    const b = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper_polish' }))).body.id);
    expect(b.status).toBe('completed');
    const job = b.jobs[0];
    const fs = job.request.face_swap;
    expect(fs).toMatchObject({ attempts: 3, polish_failed: 'misaligned' });
    expect(fs.misaligned_file_ids).toHaveLength(3);
    expect(fs.qoder_output_file_id).toBeUndefined();
    expect(await hiddenTurns(job.id)).toBe(3);
    expect(job.outputs).toHaveLength(1);
    expect(job.outputs[0].id).not.toBe(fs.swapped_file_id);
    expect((await download(job.outputs[0].url)).equals(SWAPPED)).toBe(true);
    expect(job.credits).toBeGreaterThan(0);
    expect(job.credits).toBeCloseTo(await qoderCredits(job.id), 6);
    expect((await usageOf(job.id)).filter((u) => u.model !== 'faceswap')).toHaveLength(3);
  });

  it('qoder_crop: misaligned 3 times → fails with qoder_misaligned, credits kept', async () => {
    const { target, face } = await setup();
    sidecar.misalignNext(3);
    const b = await finished((await json(await swap(target.id, { face_id: face.id, engine: 'qoder_crop' }))).body.id);
    expect(b.status).toBe('failed');
    const job = b.jobs[0];
    expect(job.error.code).toBe('qoder_misaligned');
    expect(job.outputs).toEqual([]);
    expect(job.request.face_swap).toMatchObject({ attempts: 3 });
    expect(job.request.face_swap.misaligned_file_ids).toHaveLength(3);
    expect(await hiddenTurns(job.id)).toBe(3);
    expect(job.credits).toBeGreaterThan(0);
    expect(job.credits).toBeCloseTo(await qoderCredits(job.id), 6);
  });

  it('swapper_polish: a job picked up again after a restart reuses the swapped photo and crop', async () => {
    const { target, face } = await setup();
    const first = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    const fs = { ...first.request.face_swap };
    delete fs.qoder_output_file_id;
    delete fs.alignment;
    const [copy] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({ id: `img_resume${Date.now()}`, userId: h.userId, kind: 'image', request: { ...first.request, face_swap: fs }, batchId: `batch_resume${Date.now()}` })
      .returning();
    sidecar.reset();
    await (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();
    const done = await finished(copy!.batchId!);
    expect(done.status).toBe('completed');
    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/face-paste']);
    expect(Buffer.from(sidecar.calls[0]!.body.base, 'base64').equals(SWAPPED)).toBe(true);
    expect(done.jobs[0].request.face_swap).toMatchObject({ swapped_file_id: fs.swapped_file_id, crop_file_id: fs.crop_file_id, attempts: 1 });
    expect((await download(done.jobs[0].outputs[0].url)).equals(PASTED)).toBe(true);
  });

  it('a restart between misaligned retries keeps the attempt count and the credits already spent', async () => {
    const { target, face } = await setup();
    sidecar.misalignNext(1);
    const first = (await finished((await json(await swap(target.id, { face_id: face.id, engine: 'swapper_polish' }))).body.id)).jobs[0];
    // the state right after attempt 1 was rejected: attempt 2 announced, attempt 1's credits banked, no session yet
    const banked = first.credits / 2;
    const fs = { ...first.request.face_swap, attempts: 2 };
    delete fs.qoder_output_file_id;
    delete fs.alignment;
    const [copy] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({
        id: `img_retry${Date.now()}`,
        userId: h.userId,
        kind: 'image',
        status: 'in_progress',
        startedAt: new Date(),
        credits: banked,
        request: { ...first.request, face_swap: fs },
        batchId: `batch_retry${Date.now()}`,
      })
      .returning();
    sidecar.reset();
    sidecar.misalignNext(1);
    await (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();
    const done = await finished(copy!.batchId!);
    expect(done.status).toBe('completed');
    const job = done.jobs[0];
    // no new swap or crop; attempt 2 (re-started, the turn never ran) misaligned → attempt 3 pasted
    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/face-paste', '/v1/face-paste']);
    expect(job.request.face_swap).toMatchObject({ attempts: 3, swapped_file_id: fs.swapped_file_id, crop_file_id: fs.crop_file_id });
    expect(job.request.face_swap.misaligned_file_ids).toHaveLength(2);
    expect(await hiddenTurns(job.id)).toBe(2);
    expect(job.credits).toBeCloseTo(banked + (await qoderCredits(job.id)), 6);
    expect((await download(job.outputs[0].url)).equals(PASTED)).toBe(true);
  });
});

describe('admin face swap settings', () => {
  it('is admin-only', async () => {
    expect((await h.api('/api/v1/admin/face-swap/settings')).status).toBe(403);
    expect((await h.api('/api/v1/admin/face-swap/settings', { method: 'PUT', json: {} })).status).toBe(403);
    expect((await h.api('/api/v1/admin/face-swap/test', { method: 'POST', json: {} })).status).toBe(403);
  });

  it('GET shows settings, defaults and the sidecar status', async () => {
    const r = await json(await admin('/settings'));
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect(r.body.defaults).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect(r.body.sidecar).toMatchObject({ configured: true, ready: true, models: { swapper: 'inswapper_128' } });
  });

  it('PUT merges, validates, resets with null and changes what new jobs use', async () => {
    const put = await json(
      await admin('/settings', { method: 'PUT', json: { default_engine: 'qoder', crop_expand: 2.5, swapper: { det_thresh: 0.3, restorer: 'gfpgan' } } }),
    );
    expect(put.status).toBe(200);
    expect(put.body.settings).toEqual({
      ...DEFAULT_FACE_SWAP_SETTINGS,
      default_engine: 'qoder',
      crop_expand: 2.5,
      swapper: { ...DEFAULT_FACE_SWAP_SETTINGS.swapper, det_thresh: 0.3, restorer: 'gfpgan' },
    });
    expect(put.body.defaults).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect((await json(await h.api('/api/v1/face-swap/config'))).body.default_engine).toBe('qoder');

    // a second partial update keeps the first
    const p2 = await json(await admin('/settings', { method: 'PUT', json: { qoder_prompt: '  A custom face swap prompt that is long enough.  ' } }));
    expect(p2.body.settings).toMatchObject({ default_engine: 'qoder', qoder_prompt: 'A custom face swap prompt that is long enough.', swapper: { det_thresh: 0.3 } });
    // persisted (only overrides)
    const [row] = await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'face_swap.settings'));
    expect(row!.value).toMatchObject({ default_engine: 'qoder', crop_expand: 2.5, swapper: { det_thresh: 0.3, restorer: 'gfpgan' } });

    // the new default engine and prompt apply to new jobs
    const { target, face } = await setup();
    const job = await json(await swap(target.id, { face_id: face.id }));
    expect(job.body.jobs[0].request).toMatchObject({ prompt: 'A custom face swap prompt that is long enough.', face_swap: { engine: 'qoder' } });
    await finished(job.body.id);

    for (const bad of [
      { default_engine: 'magic' },
      { crop_expand: 10 },
      { swapper: { det_thresh: 2 } },
      { swapper: { restorer: 'x' } },
      { qoder_prompt: 'short' },
      { polish_prompt: 'short' },
      { unknown: 1 },
      { swapper: { nope: 1 } },
    ]) {
      const r = await json(await admin('/settings', { method: 'PUT', json: bad }));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }

    const reset1 = await json(await admin('/settings', { method: 'PUT', json: { qoder_prompt: null, swapper: { det_thresh: null } } }));
    expect(reset1.body.settings).toMatchObject({ qoder_prompt: FACE_SWAP_PROMPT, swapper: { det_thresh: 0.5, restorer: 'gfpgan' } });
    const reset2 = await json(await admin('/settings', { method: 'PUT', json: { default_engine: null, crop_expand: null, swapper: null } }));
    expect(reset2.body.settings).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect(await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'face_swap.settings'))).toEqual([]);
  });
});

describe('face swap settings: stored overrides from before swapper_polish', () => {
  it('keep working; new fields and defaults fill in', async () => {
    const old = { default_engine: 'swapper', qoder_crop_prompt: 'An older custom close-up prompt, long enough.', swapper: { det_thresh: 0.4 } };
    await h.ctx.database.db.insert(kv).values({ key: 'face_swap.settings', value: old }).onConflictDoUpdate({ target: kv.key, set: { value: old } });
    try {
      await h.ctx.faceSwapSettings.load();
      const s = h.ctx.faceSwapSettings.get();
      expect(s).toEqual({
        ...DEFAULT_FACE_SWAP_SETTINGS,
        default_engine: 'swapper',
        qoder_crop_prompt: old.qoder_crop_prompt,
        swapper: { ...DEFAULT_FACE_SWAP_SETTINGS.swapper, det_thresh: 0.4 },
      });
      expect(s.polish_prompt).toBe(FACE_SWAP_POLISH_PROMPT);
      const put = await json(await admin('/settings', { method: 'PUT', json: { polish_prompt: 'A custom polish prompt that is long enough.', default_engine: 'swapper_polish' } }));
      expect(put.status).toBe(200);
      expect(put.body.settings).toMatchObject({ polish_prompt: 'A custom polish prompt that is long enough.', default_engine: 'swapper_polish', qoder_crop_prompt: old.qoder_crop_prompt });
      const { target, face } = await setup();
      const r = await json(await swap(target.id, { face_id: face.id }));
      expect(r.body.jobs[0].request).toMatchObject({ prompt: 'A custom polish prompt that is long enough.', face_swap: { engine: 'swapper_polish' } });
      await finished(r.body.id);
    } finally {
      await h.ctx.database.db.delete(kv).where(eq(kv.key, 'face_swap.settings'));
      await h.ctx.faceSwapSettings.load();
    }
  });

  it('defaults: swapper_polish engine, neutral close-up prompt without bangs changes, the polish prompt', () => {
    expect(DEFAULT_FACE_SWAP_SETTINGS.default_engine).toBe('swapper_polish');
    expect(DEFAULT_FACE_SWAP_SETTINGS.polish_prompt).toBe(FACE_SWAP_POLISH_PROMPT);
    expect(FACE_SWAP_CROP_PROMPT).toMatch(/^Make the person in image 1 look exactly like the person in image 2\./);
    expect(FACE_SWAP_CROP_PROMPT).toContain('Do not add, remove or restyle bangs/fringe; keep the hairline and every hair strand of image 1 exactly.');
    expect(FACE_SWAP_CROP_PROMPT).not.toMatch(/\bwoman\b/);
    expect(FACE_SWAP_POLISH_PROMPT).toMatch(/^Photo retouch of a close-up crop\./);
  });
});

describe('POST /admin/face-swap/test', () => {
  it('runs the swapper synchronously without creating a job', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    const before = (await h.ctx.database.db.select().from(mediaJobs)).length;
    const r = await json(
      await admin('/test', { method: 'POST', json: { target_file_id: target.id, face_id: face.id, settings_override: { swapper: { identity_mode: 'frontal', restorer: 'off' } } } }),
    );
    expect(r.status).toBe(200);
    expect(r.body.engine).toBe('swapper');
    expect(r.body.image_data_url).toBe(`data:image/png;base64,${SWAPPED.toString('base64')}`);
    expect(r.body.timings_ms).toMatchObject({ swap: 12 });
    expect(typeof r.body.timings_ms.total).toBe('number');
    expect(sidecar.calls[0]!.body.options).toEqual({ ...DEFAULT_FACE_SWAP_SETTINGS.swapper, identity_mode: 'frontal', restorer: 'off' });
    expect((await h.ctx.database.db.select().from(mediaJobs)).length).toBe(before);
  });

  it('refuses qoder engines and reports sidecar errors', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    for (const engine of ['qoder', 'qoder_crop', 'swapper_polish']) {
      const q = await json(await admin('/test', { method: 'POST', json: { target_file_id: target.id, face_id: face.id, engine } }));
      expect(q.status, engine).toBe(400);
      expect(q.body.error.code).toBe('test_engine_unsupported');
    }
    sidecar.failNext('/v1/swap', 422, 'NO_FACE_IN_SOURCE');
    const e = await json(await admin('/test', { method: 'POST', json: { target_file_id: target.id, face_id: face.id } }));
    expect(e.status).toBe(400);
    expect(e.body.error.code).toBe('no_face_in_source');
    expect((await json(await admin('/test', { method: 'POST', json: { target_file_id: target.id, face_id: 'face_missing' } }))).body.error.code).toBe('face_not_found');
  });
});

describe('admin face swap experiments: settings_override and tag', () => {
  const adminSwap = (fileId: string, payload: unknown) => h.api(`/api/v1/images/${fileId}/face-swap`, { method: 'POST', json: payload, key: h.admin.apiKey });
  const adminFinished = async (batchId: string) => {
    await readSse(await h.api(`/api/v1/images/batches/${batchId}/events`, { key: h.admin.apiKey }));
    return (await json(await h.api(`/api/v1/images/batches/${batchId}`, { key: h.admin.apiKey }))).body;
  };
  const POLISH = 'An experimental polish prompt that is long enough.';
  const CROP_PROMPT = 'An experimental close-up prompt that is long enough.';
  const WHOLE = 'An experimental whole-photo prompt that is long enough.';

  it('applies the override to this batch only (snapshot used by every step) and leaves global settings untouched', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    const override = { polish_prompt: POLISH, crop_expand: 3, swapper: { det_thresh: 0.3, restorer: 'off', identity_mode: null } };
    const r = await json(await adminSwap(target.id, { face_id: face.id, engine: 'swapper_polish', settings_override: override, tag: 'exp-1:a.b_c' }));
    expect(r.status).toBe(202);
    const options = { ...DEFAULT_FACE_SWAP_SETTINGS.swapper, det_thresh: 0.3, restorer: 'off' };
    expect(r.body.jobs[0].request).toMatchObject({ prompt: POLISH, face_swap: { engine: 'swapper_polish', crop_expand: 3, options, tag: 'exp-1:a.b_c' } });
    expect((await adminFinished(r.body.id)).status).toBe('completed');
    expect(sidecar.calls.find((c) => c.path === '/v1/swap')!.body.options).toEqual(options);
    expect(sidecar.calls.find((c) => c.path === '/v1/face-crop')!.body).toMatchObject({ expand: 3, det_thresh: 0.3 });
    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, r.body.jobs[0].id));
    const s = h.qoder.state.sessions.get(row!.qoderSessionId!)!;
    expect(JSON.stringify(s)).toContain(POLISH);

    // global settings untouched; the next batch without override uses them
    expect(h.ctx.faceSwapSettings.get()).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect(await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'face_swap.settings'))).toEqual([]);
    const plain = await json(await adminSwap(target.id, { face_id: face.id, engine: 'swapper_polish' }));
    expect(plain.body.jobs[0].request).toMatchObject({ prompt: FACE_SWAP_POLISH_PROMPT, face_swap: { crop_expand: 2.2, options: DEFAULT_FACE_SWAP_SETTINGS.swapper } });
    expect(plain.body.jobs[0].request.face_swap.tag).toBeUndefined();
    await adminFinished(plain.body.id);
  });

  it('default_engine in the override picks the engine only when engine is omitted; prompts follow the engine', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    const override = { default_engine: 'qoder_crop', qoder_crop_prompt: CROP_PROMPT, qoder_prompt: WHOLE };
    const a = await json(await adminSwap(target.id, { face_id: face.id, settings_override: override }));
    expect(a.body.jobs[0].request).toMatchObject({ prompt: CROP_PROMPT, face_swap: { engine: 'qoder_crop' } });
    const b = await json(await adminSwap(target.id, { face_id: face.id, engine: 'qoder', settings_override: override }));
    expect(b.body.jobs[0].request).toMatchObject({ prompt: WHOLE, face_swap: { engine: 'qoder' } });
    await adminFinished(a.body.id);
    await adminFinished(b.body.id);
  });

  it('validates override and tag (400) and refuses both for non-admins (403)', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    for (const bad of [
      { settings_override: { crop_expand: 10 } },
      { settings_override: { polish_prompt: 'short' } },
      { settings_override: { unknown: 1 } },
      { settings_override: { swapper: { restorer: 'x' } } },
      { tag: '' },
      { tag: 'has space' },
      { tag: 'x'.repeat(65) },
      { tag: 5 },
    ]) {
      const r = await json(await adminSwap(target.id, { face_id: face.id, ...bad }));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
    const user = await setup();
    for (const extra of [{ settings_override: { crop_expand: 3 } }, { tag: 'exp' }, { settings_override: { crop_expand: 10 } }]) {
      const r = await json(await swap(user.target.id, { face_id: user.face.id, ...extra }));
      expect(r.status, JSON.stringify(extra)).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    }
    expect((await h.api('/api/v1/admin/face-swap/jobs?tag=exp')).status).toBe(403);
  });

  it('GET /admin/face-swap/jobs?tag= lists the admin own tagged jobs, newest first, all statuses', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    const first = await json(await adminSwap(target.id, { face_id: face.id, engine: 'qoder', n: 2, tag: 'list-me' }));
    await adminFinished(first.body.id);
    sidecar.failNext('/v1/swap', 422, 'NO_FACE_IN_TARGET');
    const second = await json(await adminSwap(target.id, { face_id: face.id, engine: 'swapper', tag: 'list-me' }));
    const failed = await adminFinished(second.body.id);
    expect(failed.status).toBe('failed');
    await adminFinished((await json(await adminSwap(target.id, { face_id: face.id, engine: 'swapper', tag: 'other' }))).body.id);

    const r = await json(await admin('/jobs?tag=list-me'));
    expect(r.status).toBe(200);
    // newest first: the later batch, then both jobs of the first batch (same created_at)
    expect(r.body.data[0].id).toBe(second.body.jobs[0].id);
    expect(r.body.data.slice(1).map((j: any) => j.id).sort()).toEqual(first.body.jobs.map((j: any) => j.id).sort());
    expect(r.body.data.map((j: any) => j.status)).toEqual(['failed', 'completed', 'completed']);
    expect(r.body.data.every((j: any) => j.request.face_swap.tag === 'list-me')).toBe(true);
    expect((await json(await admin('/jobs?tag=nothing-here'))).body.data).toEqual([]);
    expect((await admin('/jobs')).status).toBe(400);
    expect((await admin('/jobs?tag=bad%20tag')).status).toBe(400);
  });
});
