import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { FolaxClient, folaxError } from '../../src/providers/folax.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { type Harness, startHarness } from './harness.js';

/** Folax adapter v0.5 client basics (errors, usage, upstream health) and GET /folax/status. */

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

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let folax: FakeFolax;
let h: Harness;
let rx: Awaited<ReturnType<typeof startReceiver>>;
const client = (statusCacheMs = 0) => new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger, statusCacheMs });

beforeAll(async () => {
  folax = await startFakeFolax();
  rx = await startReceiver();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key, WEBHOOK_POLL_INTERVAL_MS: '50' } });
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
  await rx?.close();
});

describe('folaxError', () => {
  it('maps quota, busy, down and rejection codes', () => {
    const body = (code: string) => ({ error: { message: `m:${code}`, type: 'x', code, param: null } });
    expect(folaxError(429, body('quota_exceeded'), '86400')).toMatchObject({ status: 429, code: 'folax_quota_exceeded', details: { folax_code: 'quota_exceeded', retry_after: 86400 } });
    expect(folaxError(429, body('queue_timeout'), '5')).toMatchObject({ status: 429, code: 'provider_busy', details: { retry_after: 5 } });
    expect(folaxError(429, body('too_many_jobs'), '30')).toMatchObject({ status: 429, code: 'provider_busy' });
    expect(folaxError(502, body('auth_invalid'))).toMatchObject({ status: 503, code: 'provider_unavailable', details: { folax_code: 'auth_invalid' } });
    expect(folaxError(503, body('not_configured'))).toMatchObject({ status: 503, code: 'provider_unavailable' });
    expect(folaxError(400, body('invalid_image'))).toMatchObject({ status: 400, code: 'invalid_image', message: 'm:invalid_image' });
    expect(folaxError(422, body('content_rejected'))).toMatchObject({ status: 422, code: 'content_rejected' });
    expect(folaxError(504, body('upstream_timeout'))).toMatchObject({ status: 504, code: 'folax_timeout' });
    expect(folaxError(502, body('upstream_task_failed'))).toMatchObject({ status: 502, code: 'folax_failed', message: 'Folax: m:upstream_task_failed' });
    expect(folaxError(409, body('idempotency_key_reused'))).toMatchObject({ status: 502, code: 'folax_failed' });
  });

  it('treats a 401 (our adapter key) as provider unavailable and survives a non-JSON body', () => {
    expect(folaxError(401, null)).toMatchObject({ status: 503, code: 'provider_unavailable', details: { folax_code: 'unauthorized' } });
    expect(folaxError(500, 'oops')).toMatchObject({ status: 502, code: 'folax_failed', details: { folax_code: 'http_500' } });
  });
});

describe('FolaxClient', () => {
  it('sends the API key and Idempotency-Key, and throws mapped errors', async () => {
    const c = client();
    await c.api('/v1/usage', { idempotencyKey: 'job_123' });
    expect(folax.calls[0]!.headers).toMatchObject({ 'x-api-key': folax.key, 'idempotency-key': 'job_123' });

    folax.failNext('GET /v1/usage', 429, 'quota_exceeded', { 'Retry-After': '3600' });
    await expect(c.api('/v1/usage')).rejects.toMatchObject({ code: 'folax_quota_exceeded', details: { retry_after: 3600 } });
  });

  it('reads usage and caches it', async () => {
    const c = client(60_000);
    const u = await c.usage();
    expect(u).toMatchObject({ video: { remaining: 12, source: 'observed' }, edit: { remaining: null, source: 'unknown' } });
    await c.usage();
    expect(folax.callsTo('GET /v1/usage')).toHaveLength(1);
    c.invalidateUsage();
    await c.usage();
    expect(folax.callsTo('GET /v1/usage')).toHaveLength(2);
  });

  it('returns null usage when the adapter cannot answer', async () => {
    folax.failNext('GET /v1/usage', 502, 'upstream_error');
    expect(await client().usage()).toBeNull();
  });

  it('reports ok / degraded / down from /health/upstream', async () => {
    const c = client();
    expect(await c.upstream()).toMatchObject({ status: 'ok', error: null, token: { accepted: true, jwt_expired: true } });
    folax.state.upstream = { status: 'degraded', errorCode: 'upstream_timeout' };
    expect(await c.upstream()).toMatchObject({ status: 'degraded', error: { code: 'upstream_timeout' } });
    expect(await c.available()).toBe(true);
    folax.state.upstream = { status: 'down', errorCode: 'auth_invalid' };
    expect(await c.upstream()).toMatchObject({ status: 'down', error: { code: 'auth_invalid' }, token: { accepted: false } });
    expect(await c.available()).toBe(false);
    expect(folax.callsTo('GET /health/upstream').at(-1)!.path).not.toContain('fresh');
    await c.upstream(true);
    expect(folax.callsTo('GET /health/upstream').at(-1)!.path).toContain('fresh=1');
  });

  it('is down (unreachable) when the adapter does not answer', async () => {
    const dead = new FolaxClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', log: silentLogger });
    expect(await dead.upstream()).toMatchObject({ status: 'down', error: { code: 'unreachable' } });
    await expect(dead.api('/v1/usage')).rejects.toMatchObject({ status: 503, code: 'provider_unavailable', details: { folax_code: 'unreachable' } });
  });

  it('marks itself down when a call answers auth_invalid', async () => {
    const c = client(60_000);
    expect(await c.available()).toBe(true);
    const seen: string[] = [];
    c.onDown = (err) => seen.push(String(err.details?.folax_code));
    folax.failNext('GET /v1/usage', 502, 'auth_invalid');
    await expect(c.api('/v1/usage')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await c.available()).toBe(false); // from cache, no new probe
    expect(seen).toEqual(['auth_invalid']);
  });
});

describe('GET /folax/status', () => {
  it('shows availability and the shared quota to users, cached', async () => {
    const r = await h.api('/api/v1/folax/status');
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ configured: true, available: true, status: 'ok', error: null, usage: { video: { remaining: 12 }, edit: { source: 'unknown' } } });
    expect(body.token).toBeUndefined();
    await h.api('/api/v1/folax/status');
    expect(folax.callsTo('GET /health/upstream')).toHaveLength(1);
  });

  it('admin status checks now and includes the token details', async () => {
    expect((await h.api('/api/v1/admin/folax/status')).status).toBe(403);
    const r = await h.api('/api/v1/admin/folax/status', { key: h.admin.apiKey });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ configured: true, status: 'ok', token: { accepted: true, jwt_expired: true }, latency_ms: 1500 });
    expect(folax.callsTo('GET /health/upstream')[0]!.path).toContain('fresh=1');
  });

  it('a rejected token makes Folax unavailable and tells admins (provider.degraded)', async () => {
    const hook = await h.api('/api/v1/webhooks', { method: 'POST', key: h.admin.apiKey, json: { url: `${rx.url}/admin`, events: ['provider.degraded'] } });
    expect(hook.status).toBe(201);
    folax.state.upstream = { status: 'down', errorCode: 'auth_invalid' };
    const r = await h.api('/api/v1/admin/folax/status', { key: h.admin.apiKey });
    expect(await r.json()).toMatchObject({ available: false, status: 'down', error: { code: 'auth_invalid' }, token: { accepted: false } });
    const delivered = await waitFor(() => rx.received, (x) => x.length >= 1);
    expect(delivered[0]).toMatchObject({ type: 'provider.degraded', data: { provider: 'folax', code: 'folax_auth_invalid' } });
    // the user view now serves the cached `down`
    expect(await (await h.api('/api/v1/folax/status')).json()).toMatchObject({ available: false, status: 'down' });
  });
});
