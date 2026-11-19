import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaJobs, usageEvents } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const GPU_KEY = 'gpu-key';
const CPU_KEY = 'cpu-key';
const GPU_JPEG = Buffer.from('gpu-jpeg-bytes');
const CPU_JPEG = Buffer.from('cpu-jpeg-bytes');

interface Call {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/** Fake upscale sidecar: /health/ready with `upscale.ready`, /v1/upscale; `failNext` scripts error replies. */
async function startFakeUpscaler(o: { key: string; device: 'cuda' | 'cpu'; jpeg: Buffer }) {
  const calls: Call[] = [];
  const failures: { status: number; detail: string }[] = [];
  let ready = true;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-api-key'] !== o.key) return reply(401, { detail: 'AUTH_INVALID' });
      if (req.method === 'GET' && req.url === '/health/ready')
        return reply(ready ? 200 : 503, { ready, upscale: { ready, device: o.device, pipelines: { natural: o.device === 'cuda' ? 'P5' : 'P4', sharp: 'P1' } } });
      const path = req.url ?? '';
      calls.push({ path, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const f = failures.shift();
      if (f) return reply(f.status, { detail: f.detail });
      if (path === '/v1/upscale') {
        const b = JSON.parse(raw);
        const pipeline = b.mode === 'sharp' ? 'P1' : o.device === 'cuda' ? 'P5' : 'P4';
        return reply(200, {
          image: o.jpeg.toString('base64'),
          mime_type: 'image/jpeg',
          width: 30 * b.scale,
          height: 40 * b.scale,
          scale: b.scale,
          mode: b.mode,
          pipeline,
          device: o.device,
          faces: 1,
          faces_enhanced: pipeline === 'P4' ? 1 : 0,
          timings_ms: { total: 10 },
        });
      }
      reply(404, { detail: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    setReady: (v: boolean) => (ready = v),
    failNext: (status: number, detail: string) => failures.push({ status, detail }),
    reset() {
      calls.length = 0;
      failures.length = 0;
      ready = true;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let h: Harness;
let gpu: Awaited<ReturnType<typeof startFakeUpscaler>>;
let cpu: Awaited<ReturnType<typeof startFakeUpscaler>>;
beforeAll(async () => {
  gpu = await startFakeUpscaler({ key: GPU_KEY, device: 'cuda', jpeg: GPU_JPEG });
  cpu = await startFakeUpscaler({ key: CPU_KEY, device: 'cpu', jpeg: CPU_JPEG });
  h = await startHarness({
    env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: cpu.url, FACESWAP_API_KEY: CPU_KEY, UPSCALE_GPU_URL: gpu.url, UPSCALE_GPU_API_KEY: GPU_KEY },
  });
});
afterAll(async () => {
  await h?.close();
  await gpu?.close();
  await cpu?.close();
});
beforeEach(async () => {
  gpu.reset();
  cpu.reset();
  await h.ctx.upscaler!.gpuReady(true);
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function upload(filename: string, bytes: Buffer, type = 'image/png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

const upscale = (fileId: string, payload: unknown = {}, harness = h) => harness.api(`/api/v1/images/${fileId}/upscale`, { method: 'POST', json: payload });
const finished = async (jobId: string) => {
  await readSse(await h.api(`/api/v1/jobs/${jobId}/events`));
  return (await json(await h.api(`/api/v1/jobs/${jobId}`))).body;
};
const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());

describe('GET /upscale/config', () => {
  it('reports availability, the GPU and the options', async () => {
    const r = await json(await h.api('/api/v1/upscale/config'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: true, gpu: true, max_pixels: 4_200_000, scales: [2, 4], modes: ['natural', 'sharp'], default_scale: 4, default_mode: 'natural' });
    gpu.setReady(false);
    await h.ctx.upscaler!.gpuReady(true);
    expect((await json(await h.api('/api/v1/upscale/config'))).body).toMatchObject({ available: true, gpu: false });
  });
});

describe('POST /images/:fileId/upscale', () => {
  it('202 with a job that completes on the GPU with a stored JPEG artifact', async () => {
    const bytes = makePng(30, 40);
    const src = await upload('holiday.png', bytes);
    const r = await json(await upscale(src.id, {}));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      kind: 'image',
      request: {
        prompt: 'Upscale 4x (Natural)',
        input_file_ids: [src.id],
        provider: 'upscale',
        provider_used: 'upscale',
        enhance: false,
        upscale: { source_file_id: src.id, scale: 4, mode: 'natural' },
      },
    });

    const job = await finished(r.body.id);
    expect(job.status).toBe('completed');
    expect(job.credits).toBe(0);
    expect(job.request.upscale).toEqual({ source_file_id: src.id, scale: 4, mode: 'natural', backend: 'gpu', pipeline: 'P5', device: 'cuda', width: 120, height: 160, faces_enhanced: 0 });
    expect(job.outputs).toHaveLength(1);
    expect(job.outputs[0]).toMatchObject({ name: 'upscale-4x-holiday.jpg', mime_type: 'image/jpeg', kind: 'image' });
    expect((await download(job.outputs[0].url)).equals(GPU_JPEG)).toBe(true);

    expect(cpu.calls).toEqual([]);
    const call = gpu.calls.find((c) => c.path === '/v1/upscale')!;
    expect(call.headers['x-api-key']).toBe(GPU_KEY);
    expect(call.body).toMatchObject({ scale: 4, mode: 'natural' });
    expect(Buffer.from(call.body.image, 'base64').equals(bytes)).toBe(true);
    const usage = await h.ctx.database.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'upscale', kind: 'image', creditsTotal: 0 });
  });

  it('2x sharp: prompt and file name follow scale and mode', async () => {
    const src = await upload('cat.png', makePng(30, 40));
    const r = await json(await upscale(src.id, { scale: 2, mode: 'sharp' }));
    expect(r.body.request.prompt).toBe('Upscale 2x (Sharp)');
    const job = await finished(r.body.id);
    expect(job.outputs[0].name).toBe('upscale-2x-cat.jpg');
    expect(job.request.upscale).toMatchObject({ scale: 2, mode: 'sharp', pipeline: 'P1', width: 60, height: 80 });
  });

  it('GPU not ready → the CPU sidecar runs it', async () => {
    gpu.setReady(false);
    await h.ctx.upscaler!.gpuReady(true);
    const src = await upload('a.png', makePng(30, 40));
    const job = await finished((await json(await upscale(src.id))).body.id);
    expect(job.status).toBe('completed');
    expect(job.request.upscale).toMatchObject({ backend: 'cpu', pipeline: 'P4', device: 'cpu', faces_enhanced: 1 });
    expect(gpu.calls).toEqual([]);
    expect(cpu.calls[0]!.headers['x-api-key']).toBe(CPU_KEY);
    expect((await download(job.outputs[0].url)).equals(CPU_JPEG)).toBe(true);
  });

  it('GPU 5xx → falls back to the CPU sidecar', async () => {
    gpu.failNext(503, 'MODELS_LOADING');
    const src = await upload('a.png', makePng(30, 40));
    const job = await finished((await json(await upscale(src.id))).body.id);
    expect(job.status).toBe('completed');
    expect(job.request.upscale.backend).toBe('cpu');
    expect(gpu.calls.map((c) => c.path)).toEqual(['/v1/upscale']);
    expect(cpu.calls.map((c) => c.path)).toEqual(['/v1/upscale']);
  });

  it('GPU 413 TOO_LARGE → no fallback, the job fails with image_too_large', async () => {
    gpu.failNext(413, 'TOO_LARGE');
    const src = await upload('a.png', makePng(30, 40));
    const job = await finished((await json(await upscale(src.id))).body.id);
    expect(job.status).toBe('failed');
    expect(job.error.code).toBe('image_too_large');
    expect(job.outputs).toEqual([]);
    expect(cpu.calls).toEqual([]);
  });

  it('both backends down → the job fails with upscale_unavailable', async () => {
    gpu.failNext(503, 'MODELS_FAILED');
    cpu.failNext(503, 'MODELS_LOADING');
    const src = await upload('a.png', makePng(30, 40));
    const job = await finished((await json(await upscale(src.id))).body.id);
    expect(job.status).toBe('failed');
    expect(job.error.code).toBe('upscale_unavailable');
  });

  it('rejects a source over 4.2 MP, bad options, and foreign/unknown files', async () => {
    const big = await sharp({ create: { width: 2100, height: 2001, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const src = await upload('big.jpg', big, 'image/jpeg');
    const r = await json(await upscale(src.id));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('image_too_large');

    const ok = await upload('a.png', makePng(30, 40));
    expect((await json(await upscale(ok.id, { scale: 3 }))).body.error.code).toBe('validation_error');
    expect((await json(await upscale(ok.id, { mode: 'blurry' }))).body.error.code).toBe('validation_error');
    const missing = await json(await upscale('file_nope'));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('file_not_found');
    expect(gpu.calls).toEqual([]);
  });

  it('ignores the monthly credit limit (free, no limits)', async () => {
    await h.api(`/api/v1/admin/users/${h.userId}`, { method: 'PATCH', key: h.admin.apiKey, json: { monthly_credit_limit: 0 } });
    try {
      expect((await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x' } })).status).toBe(429);
      const src = await upload('a.png', makePng(30, 40));
      const r = await json(await upscale(src.id));
      expect(r.status).toBe(202);
      expect((await finished(r.body.id)).status).toBe('completed');
    } finally {
      await h.api(`/api/v1/admin/users/${h.userId}`, { method: 'PATCH', key: h.admin.apiKey, json: { monthly_credit_limit: null } });
    }
  });

  it('a job left in_progress by a restart is run again', async () => {
    const src = await upload('a.png', makePng(30, 40));
    const [row] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({
        id: `img_upresume${Date.now()}`,
        userId: h.userId,
        kind: 'image',
        status: 'in_progress',
        startedAt: new Date(),
        request: {
          prompt: 'Upscale 4x (Natural)',
          enhance: false,
          input_file_ids: [src.id],
          provider: 'upscale',
          provider_used: 'upscale',
          upscale: { source_file_id: src.id, scale: 4, mode: 'natural' },
        },
      })
      .returning();
    await (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();
    const job = await finished(row!.id);
    expect(job.status).toBe('completed');
    expect(job.request.upscale.backend).toBe('gpu');
    expect(gpu.calls.map((c) => c.path)).toEqual(['/v1/upscale']);
  });
});

describe('without an upscale backend', () => {
  it('config says unavailable and POST is 503 upscale_unavailable', async () => {
    const bare = await startHarness();
    try {
      expect((await json(await bare.api('/api/v1/upscale/config'))).body).toMatchObject({ available: false, gpu: false });
      // checked before the file is looked up (no upload: keeps this second harness free of background thumbnail work)
      const r = await json(await upscale('file_any', {}, bare));
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('upscale_unavailable');
    } finally {
      await bare.close();
    }
  });
});
