import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookService } from '../../src/core/webhooks.js';
import { webhookDeliveries } from '../../src/db/schema.js';
import { silentLogger } from '../../src/log.js';
import { type Harness, startHarness } from './harness.js';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
}

/** Local HTTP receiver; `status(path, n)` decides the response code of the n-th call to a path. */
async function startReceiver(status: (path: string, n: number) => number = () => 200) {
  const received: Received[] = [];
  const counts = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      received.push({ path, headers: req.headers, raw, body: JSON.parse(raw || 'null') });
      res.writeHead(status(path, n)).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let h: Harness;
let rx: Awaited<ReturnType<typeof startReceiver>>;
beforeAll(async () => {
  rx = await startReceiver((path, n) => (path === '/flaky' && n < 3 ? 500 : path === '/down' ? 503 : 200));
  h = await startHarness({ mock: { videoDelayMs: 100 }, env: { MEDIA_POLL_INTERVAL_MS: '50', WEBHOOK_POLL_INTERVAL_MS: '50' } });
});
afterAll(async () => {
  await h?.close();
  await rx?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sign = (secret: string, raw: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('webhook endpoints', () => {
  it('creates (secret once), lists, tests and deletes', async () => {
    const created = await json(await h.api('/api/v1/webhooks', { method: 'POST', json: { url: `${rx.url}/hook-a`, events: ['image.completed'] } }));
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const list = await json(await h.api('/api/v1/webhooks'));
    expect(list.body.data).toEqual([{ id: created.body.id, url: `${rx.url}/hook-a`, events: ['image.completed'], created_at: expect.any(String) }]);
    expect(list.body.available_events).toContain('video.completed');

    const test = await json(await h.api(`/api/v1/webhooks/${created.body.id}/test`, { method: 'POST' }));
    expect(test.body).toMatchObject({ delivered: true, status: 200, error: null });
    const got = rx.received.find((r) => r.path === '/hook-a' && r.body.type === 'webhook.test')!;
    expect(got.headers['x-stillgpt-signature']).toBe(sign(created.body.secret, got.raw));

    expect((await h.api(`/api/v1/webhooks/${created.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await h.api('/api/v1/webhooks'))).body.data).toEqual([]);
    expect((await h.api(`/api/v1/webhooks/${created.body.id}/test`, { method: 'POST' })).status).toBe(404);
  });

  it('validates url and events', async () => {
    const r1 = await json(await h.api('/api/v1/webhooks', { method: 'POST', json: { url: 'not a url', events: ['image.completed'] } }));
    expect(r1.status).toBe(400);
    const r2 = await json(await h.api('/api/v1/webhooks', { method: 'POST', json: { url: `${rx.url}/x`, events: ['nope'] } }));
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('validation_error');
    expect((await h.api('/api/v1/webhooks', { method: 'POST', json: { url: `${rx.url}/x`, events: [] } })).status).toBe(400);
  });
});

describe('deliveries', () => {
  it('signs job events to subscribed endpoints', async () => {
    const hook = (await json(await h.api('/api/v1/webhooks', { method: 'POST', json: { url: `${rx.url}/jobs`, events: ['image.completed', 'video.completed'] } }))).body;
    const job = (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'burung' } }))).body;
    const got = await waitFor(
      () => rx.received.find((r) => r.path === '/jobs' && r.body.data.job.id === job.id),
      (r) => !!r,
    );
    expect(got!.headers['content-type']).toBe('application/json');
    expect(got!.headers['x-stillgpt-event']).toBe('image.completed');
    expect(got!.headers['x-stillgpt-delivery']).toMatch(/^whd_/);
    expect(got!.headers['x-stillgpt-signature']).toBe(sign(hook.secret, got!.raw));
    expect(got!.body).toMatchObject({ id: expect.stringMatching(/^evt_/), type: 'image.completed', created_at: expect.any(String) });
    expect(got!.body.data.job).toMatchObject({ id: job.id, status: 'completed', outputs: [{ kind: 'image', mime_type: 'image/png' }] });

    // image.failed is not subscribed by this endpoint
    await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x [[error]]' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(rx.received.filter((r) => r.path === '/jobs' && r.body.type === 'image.failed')).toEqual([]);
  });

  it('delivers to callback_url without a signature (n8n Wait node)', async () => {
    const job = (await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'kota malam', seconds: 3, callback_url: `${rx.url}/resume/abc` } }))).body;
    const got = await waitFor(
      () => rx.received.find((r) => r.path === '/resume/abc'),
      (r) => !!r,
    );
    expect(got!.headers['x-stillgpt-signature']).toBeUndefined();
    expect(got!.body).toMatchObject({ type: 'video.completed', data: { job: { id: job.id, status: 'completed', kind: 'video' } } });
    expect(got!.body.data.job.outputs[0].url).toContain('/media/');
  });

  it('sends model.* events to admin endpoints', async () => {
    await h.api('/api/v1/webhooks', { method: 'POST', key: h.admin.apiKey, json: { url: `${rx.url}/models`, events: ['model.added'] } });
    h.qoder.addModel({ id: 'newmodel', display_name: 'New Model' });
    await h.api('/api/v1/admin/models/sync', { method: 'POST', key: h.admin.apiKey });
    const got = await waitFor(
      () => rx.received.find((r) => r.path === '/models'),
      (r) => !!r,
    );
    expect(got!.body).toMatchObject({ type: 'model.added', data: { model: { id: 'newmodel', display_name: 'New Model' } } });
  });

  it('retries with backoff and gives up after the last retry', async () => {
    // a second worker with short retry delays on the same table; pause the app's own worker meanwhile
    await h.ctx.webhooks.stop();
    const svc = new WebhookService(h.ctx.database.db, silentLogger, fetch, { pollIntervalMs: 20, retryDelaysMs: [30, 30, 30] });
    svc.start();
    try {
      await svc.deliverTo(`${rx.url}/flaky`, 'video.completed', { n: 1 });
      await svc.deliverTo(`${rx.url}/down`, 'video.failed', { n: 2 });
      const db = h.ctx.database.db;
      const byUrl = (path: string) => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.url, `${rx.url}${path}`));
      const flaky = await waitFor(() => byUrl('/flaky'), (rows) => rows[0]?.status === 'delivered');
      expect(flaky[0]!.attempts).toBe(3);
      const down = await waitFor(() => byUrl('/down'), (rows) => rows[0]?.status === 'failed');
      expect(down[0]).toMatchObject({ attempts: 4, lastError: 'HTTP 503' });
      expect(rx.received.filter((r) => r.path === '/down')).toHaveLength(4);
    } finally {
      await svc.stop();
      h.ctx.webhooks.start();
    }
  });
});
