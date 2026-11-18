import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { webhookDeliveries } from '../../src/db/schema.js';
import { toFolaxRatio } from '../../src/providers/folax.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

const FOLAX_KEY = 'folax-test-key';
/** Smallest thing that starts like a JPEG; the store does not decode images. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

interface FolaxCall {
  headers: IncomingHttpHeaders;
  body: { prompt: string; ratio: string };
}

/** Fake folax-adapter: POST /v1/images/generate-all → 2 images; `failNext` scripts error replies. */
async function startFakeFolax() {
  const calls: FolaxCall[] = [];
  const failures: { status: number; detail: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method !== 'POST' || req.url !== '/v1/images/generate-all') return reply(404, { detail: 'Not Found' });
      if (req.headers['x-api-key'] !== FOLAX_KEY) return reply(401, { detail: 'UNAUTHORIZED' });
      calls.push({ headers: req.headers, body: JSON.parse(raw) });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      const fail = failures.shift();
      if (fail) return reply(fail.status, { detail: fail.detail });
      reply(200, {
        images: [
          { file_name: 'folax-1.jpg', mime_type: 'image/jpeg', data: JPEG.toString('base64') },
          { file_name: 'folax-2.png', mime_type: 'image/png', data: makePng().toString('base64') },
        ],
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    failNext: (status: number, detail: string) => failures.push({ status, detail }),
    maxActive: () => maxActive,
    reset() {
      calls.length = 0;
      failures.length = 0;
      maxActive = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Collects webhook deliveries (admin endpoint for provider.degraded). */
async function startReceiver() {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let h: Harness;
let folax: Awaited<ReturnType<typeof startFakeFolax>>;
let rx: Awaited<ReturnType<typeof startReceiver>>;
let client: OpenAI;
beforeAll(async () => {
  folax = await startFakeFolax();
  rx = await startReceiver();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: FOLAX_KEY, MEDIA_POLL_INTERVAL_MS: '50', WEBHOOK_POLL_INTERVAL_MS: '50' } });
  client = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1`, maxRetries: 0 });
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
  await rx?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const createImage = async (payload: Record<string, unknown>) => json(await h.api('/api/v1/images', { method: 'POST', json: payload }));
const sessionCount = () => h.qoder.state.sessions.size;

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function upload(bytes: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'in.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

describe('ratio mapping', () => {
  it('maps sizes and ratios to the nearest Folax ratio', () => {
    expect(toFolaxRatio('1024x1024')).toBe('1:1');
    expect(toFolaxRatio('1792x1024')).toBe('16:9');
    expect(toFolaxRatio('2560x1080')).toBe('16:9');
    expect(toFolaxRatio('1024x1792')).toBe('9:16');
    expect(toFolaxRatio('1024x1280')).toBe('3:4');
    expect(toFolaxRatio('768x1024')).toBe('3:4');
    expect(toFolaxRatio('1536x1024')).toBe('4:3');
    expect(toFolaxRatio('4:5')).toBe('3:4');
    expect(toFolaxRatio('nonsense')).toBe('1:1');
  });
});

describe('folax provider (native)', () => {
  it('explicit folax: two downloadable outputs, no Qoder session, 0 credits', async () => {
    const before = sessionCount();
    const r = await createImage({ prompt: 'kucing oranye', provider: 'folax', size: '1792x1024' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', progress: 100, credits: 0, request: { provider: 'folax', provider_used: 'folax', size: '1792x1024' } });
    expect(r.body.request.fallback_reason).toBeUndefined();
    expect(r.body.outputs).toHaveLength(2);
    expect(r.body.outputs.map((o: any) => o.mime_type)).toEqual(['image/jpeg', 'image/png']);
    for (const out of r.body.outputs) {
      const res = await fetch(out.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(out.mime_type);
    }
    expect(sessionCount()).toBe(before);
    expect(folax.calls).toHaveLength(1);
    expect(folax.calls[0]!.body).toEqual({ prompt: 'kucing oranye', ratio: '16:9' });

    const usage = await json(await h.api('/api/v1/usage'));
    expect(usage.body.by_kind.image).toMatchObject({ credits: 0 });
    expect(usage.body.by_kind.image.requests).toBeGreaterThanOrEqual(1);
  });

  it('auto (default) uses folax for text-to-image with the nearest ratio', async () => {
    const r = await createImage({ prompt: 'poster', size: '1024x1280' });
    expect(r.body).toMatchObject({ status: 'completed', request: { provider: 'auto', provider_used: 'folax' } });
    expect(r.body.outputs).toHaveLength(2);
    expect(folax.calls[0]!.body.ratio).toBe('3:4');
  });

  it('serialises folax calls (upstream concurrency 1)', async () => {
    const jobs = await Promise.all([1, 2, 3].map((i) => createImage({ prompt: `antre ${i}`, async: true })));
    for (const j of jobs) await waitFor(async () => (await json(await h.api(`/api/v1/jobs/${j.body.id}`))).body.status, (s) => s === 'completed');
    expect(folax.calls).toHaveLength(3);
    expect(folax.maxActive()).toBe(1);
  });

  it('auto falls back to Qoder when folax fails and tells admins once per hour', async () => {
    const hook = await json(
      await h.api('/api/v1/webhooks', { method: 'POST', key: h.admin.apiKey, json: { url: `${rx.url}/admin`, events: ['provider.degraded'] } }),
    );
    expect(hook.status).toBe(201);

    folax.failNext(502, 'AUTH_INVALID');
    const r = await createImage({ prompt: 'kucing hitam' });
    expect(r.body).toMatchObject({ status: 'completed', request: { provider: 'auto', provider_used: 'qoder', fallback_reason: 'folax_auth_invalid' } });
    expect(r.body.outputs).toHaveLength(1);
    expect(r.body.outputs[0].mime_type).toBe('image/png');
    expect(r.body.credits).toBeGreaterThan(0);

    const delivered = await waitFor(() => rx.received, (x) => x.length >= 1);
    expect(delivered[0]).toMatchObject({ type: 'provider.degraded', data: { provider: 'folax', code: 'folax_auth_invalid', message: expect.stringContaining('AUTH_INVALID') } });

    folax.failNext(502, 'AUTH_INVALID');
    const again = await createImage({ prompt: 'kucing putih' });
    expect(again.body.request.provider_used).toBe('qoder');
    await new Promise((r) => setTimeout(r, 200));
    const rows = await h.ctx.database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, 'provider.degraded'));
    expect(rows).toHaveLength(1);
  });

  it('explicit folax does not fall back', async () => {
    folax.failNext(504, 'UPSTREAM_TIMEOUT');
    const r = await createImage({ prompt: 'lambat', provider: 'folax' });
    expect(r.body).toMatchObject({ status: 'failed', error: { code: 'folax_timeout' }, outputs: [], request: { provider_used: 'folax' } });
  });

  it('edits always use Qoder; explicit folax with input images is rejected', async () => {
    const png = await upload(makePng());
    const r = await createImage({ prompt: 'tambah topi', input_file_ids: [png.id] });
    expect(r.body).toMatchObject({ status: 'completed', request: { provider: 'auto', provider_used: 'qoder' } });
    expect(folax.calls).toHaveLength(0);

    const bad = await createImage({ prompt: 'tambah topi', input_file_ids: [png.id], provider: 'folax' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    expect((await createImage({ prompt: 'x', provider: 'dalle' })).status).toBe(400);
  });

  it('explicit qoder skips folax', async () => {
    const r = await createImage({ prompt: 'anjing', provider: 'qoder' });
    expect(r.body).toMatchObject({ status: 'completed', request: { provider: 'qoder', provider_used: 'qoder' } });
    expect(folax.calls).toHaveLength(0);
  });

  it('lists image providers', async () => {
    const models = await json(await h.api('/api/v1/models'));
    expect(models.body.default_image_provider).toBe('auto');
    expect(models.body.image_providers).toEqual([
      expect.objectContaining({ id: 'qoder', available: true, edits: true }),
      expect.objectContaining({ id: 'folax', available: true, edits: false, images_per_call: 2, ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'] }),
    ]);
  });
});

describe('folax provider (OpenAI images API)', () => {
  it('folax-image returns up to n images, calling folax again when n > 2', async () => {
    const three = await client.images.generate({ model: 'folax-image', prompt: 'pemandangan', n: 3, size: '1536x1024' });
    expect(three.data).toHaveLength(3);
    expect(folax.calls).toHaveLength(2);
    expect(folax.calls.every((c) => c.body.ratio === '4:3')).toBe(true);

    folax.reset();
    const one = await client.images.generate({ model: 'folax-image', prompt: 'pemandangan', response_format: 'b64_json' });
    expect(one.data).toHaveLength(1);
    expect(Buffer.from(one.data![0]!.b64_json!, 'base64').subarray(0, 3)).toEqual(JPEG.subarray(0, 3));
    expect(folax.calls).toHaveLength(1);
  });

  it('qoder-image goes to Qoder; OpenAI model names use the default provider', async () => {
    const q = await client.images.generate({ model: 'qoder-image', prompt: 'kucing' });
    expect(q.data).toHaveLength(1);
    expect(folax.calls).toHaveLength(0);

    const d = await client.images.generate({ model: 'dall-e-3', prompt: 'kucing', n: 2 });
    expect(d.data).toHaveLength(2);
    expect(folax.calls).toHaveLength(1);
  });

  it('lists folax-image in /v1/models', async () => {
    const list = await client.models.list();
    const ids = list.data.map((m) => m.id);
    expect(ids).toContain('folax-image');
    expect(ids).toContain('qoder-image');
  });
});

describe('long prompts under auto', () => {
  it('go to Qoder instead of being cut at the Folax limit', async () => {
    const prompt = `Poster with the headline "Diskon 50% Hari Ini" ${'and rich detail '.repeat(110)}`;
    expect(prompt.length).toBeGreaterThan(1500);
    const r = await h.api('/api/v1/images', { method: 'POST', json: { prompt } });
    const job = (await r.json()) as any;
    expect(job.request).toMatchObject({ provider: 'auto', provider_used: 'qoder', fallback_reason: 'prompt_too_long_for_folax' });
    expect(job.status).toBe('completed');
    expect(folax.calls).toHaveLength(0);
  });
});
