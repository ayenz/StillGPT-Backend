import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeCookie } from '../../src/core/qoderCredits.js';
import { type Harness, startHarness } from './harness.js';

// Cookie layout: base64url("<issued unix seconds>|data|mac").
const ENV_COOKIE = Buffer.from('1794820410|env-data|mac').toString('base64url');
const NEW_COOKIE = Buffer.from('1794900000|new-data|mac').toString('base64url');

const usage = (used: number) => ({
  user_id: 'u1',
  quota_key: 'big_model_credits',
  status: 'active',
  plan_quota: { quota_summary: { used_value: used, limit_value: 2580, remaining_value: 2580 - used, usage_percentage: 4, unit: 'credits' } },
  resource_package_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, usage_percentage: 0, unit: 'credits' }, quota_detail: null },
  dedicated_resource_package_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, usage_percentage: 0, unit: 'credits' }, quota_detail: null },
  total_quota: { quota_summary: { used_value: used, limit_value: 2580, remaining_value: 2580 - used, usage_percentage: 4, unit: 'credits' } },
  lastResetAt: 1787820225747,
  nextResetAt: 1797059301000,
});

const HISTORY = {
  data: [
    {
      time: 1794823948000, begin_at: 1794823948000, finish_at: 1794823948000, session_id: 'sess_a', business_id: 'video_1', name: '',
      source: 'Cloud Agents', operation: 'Video', kind: 'Charged', credits: 85.71, original_credits: 85.71, model_category: 'Auto',
      cost: 0.85, original_cost: 0.85, discount_factor: 1, discount_visible: true,
    },
    {
      time: 1787821461616, begin_at: 1787821461616, finish_at: 1787821467002, session_id: 'bcf75217', business_id: 'b1', name: '',
      source: 'Qoder', operation: 'Agent', kind: 'Charged', credits: 1.43, original_credits: 2.87, model_category: 'Qwen3.8-Max',
      cost: 0.01, original_cost: 0.03, discount_factor: 0.5, discount_visible: true,
    },
  ],
  summary: { credits: 87.14, cost: 0.86, original_credits: 88.58, original_cost: 0.88 },
  page_result: { prev_page: 0, current_page: 1, next_page: 2, last_page: 187, page_size: 2, total_size: 373, next_token: 'x' },
};

const ORG_USAGE = {
  user_id: 'u1',
  organization_id: 'o1',
  quota_key: 'big_model_credits',
  shared_quota: {
    quota_summary: { used_value: 23, limit_value: -1, remaining_value: 195631, usage_percentage: 0, unit: 'credits' },
    quota_detail: [
      { id: 'p1', limit_value: 195631, used_value: 0, remaining_value: 195631, unit: 'credits', is_active: true, usage_percentage: 0, expires_at: 1826700050206, source: 'ORGANIZATION_RESOURCE_PACKAGE', status: 'ACTIVE' },
    ],
  },
  organization_pool: { used_value: 14369, limit_value: 210000, remaining_value: 195631, usage_percentage: 7, unit: 'credits' },
};

/** Fake qoder.com: accepts the cookies in `valid`, counts hits. */
const web = { valid: new Set([ENV_COOKIE]), org: true, hits: 0, used: 92, lastCookie: '', lastQuery: new URLSearchParams() };
let server: Server;
let h: Harness;

beforeAll(async () => {
  server = createServer((req, res) => {
    web.hits++;
    web.lastCookie = String(req.headers.cookie ?? '');
    const m = /qoder_session_cookie=([^;]+)/.exec(web.lastCookie);
    const url = new URL(req.url!, 'http://x');
    const known = ['/api/v2/me/usages/big_model_credits', '/api/v1/me/usages/big_model_credits/histories', '/api/v1/me/organization-shared-usages/big_model_credits'];
    if (!known.includes(url.pathname)) return void res.writeHead(404).end();
    if (!m || !web.valid.has(m[1]!)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"errorCode":"Unauthorized","errorMessage":"User not authenticated"}');
      return;
    }
    if (url.pathname.includes('organization-shared')) {
      if (!web.org) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ORG_USAGE));
      return;
    }
    if (url.pathname.endsWith('/histories')) {
      web.lastQuery = url.searchParams;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(HISTORY));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(usage(web.used)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  h = await startHarness({
    env: { QODER_WEB_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, QODER_WEB_SESSION: ENV_COOKIE, QODER_HOUSEKEEPING_INTERVAL_HOURS: '0' },
  });
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('qoder credits (admin)', () => {
  const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin/qoder${path}`, { ...init, key: h.admin.apiKey });

  it('normalizes pasted cookies', () => {
    expect(normalizeCookie('abc')).toBe('abc');
    expect(normalizeCookie(' qoder_session_cookie=abc ')).toBe('abc');
    expect(normalizeCookie('Cookie: x=1; qoder_session_cookie=abc; isg=zz')).toBe('abc');
  });

  it('reads credits with the env cookie, caches, expires, and takes a new cookie from an admin', async () => {
    expect((await h.api('/api/v1/admin/qoder/credits')).status).toBe(403);

    const first = (await (await admin('/credits')).json()) as any;
    expect(first).toMatchObject({
      status: 'ok',
      stale: false,
      error: null,
      credits: {
        used: 92,
        limit: 2580,
        remaining: 2488,
        usage_percentage: 4,
        unit: 'credits',
        plan: { remaining: 2488 },
        resource_package: { limit: 0 },
        next_reset_at: new Date(1797059301000).toISOString(),
        add_on: {
          used: 23,
          cap: null,
          remaining: 195631,
          pool: { used: 14369, limit: 210000, remaining: 195631, usage_percentage: 7 },
          expires_at: new Date(1826700050206).toISOString(),
        },
      },
      session: { configured: true, source: 'env', issued_at: new Date(1794820410 * 1000).toISOString(), updated_at: null },
    });
    expect(web.lastCookie).toBe(`qoder_session_cookie=${ENV_COOKIE}`);

    // Cached: no second upstream hit; refresh=true forces one. No organization → add_on null, rest still ok.
    const hits = web.hits;
    web.used = 100;
    web.org = false;
    expect(((await (await admin('/credits')).json()) as any).credits.used).toBe(92);
    expect(web.hits).toBe(hits);
    const noOrg = (await (await admin('/credits?refresh=true')).json()) as any;
    expect(noOrg).toMatchObject({ status: 'ok', credits: { used: 100, add_on: null } });
    web.org = true;

    // Session expires upstream: last reading stays, marked stale.
    web.valid.clear();
    const expired = (await (await admin('/credits?refresh=1')).json()) as any;
    expect(expired).toMatchObject({ status: 'session_expired', stale: true, credits: { used: 100 } });
    expect(expired.error).toBeTruthy();

    // Admin pastes a fresh cookie (whole header is fine) → stored, used, fetched right away.
    expect((await admin('/session', { method: 'PUT', json: { cookie: 'x' } })).status).toBe(400);
    web.valid.add(NEW_COOKIE);
    const updated = (await (await admin('/session', { method: 'PUT', json: { cookie: `isg=1; qoder_session_cookie=${NEW_COOKIE}` } })).json()) as any;
    expect(updated).toMatchObject({ status: 'ok', stale: false, credits: { used: 100 }, session: { source: 'admin', issued_at: new Date(1794900000 * 1000).toISOString() } });
    expect(updated.session.updated_at).toBeTruthy();
    expect(JSON.stringify(updated)).not.toContain(NEW_COOKIE);
    expect(web.lastCookie).toBe(`qoder_session_cookie=${NEW_COOKIE}`);

    // Clearing goes back to the env cookie (now rejected upstream).
    const cleared = (await (await admin('/session', { method: 'DELETE' })).json()) as any;
    expect(cleared).toMatchObject({ status: 'session_expired', stale: false, credits: null, session: { source: 'env' } });
  });

  it('pages through the credit history', async () => {
    web.valid.add(ENV_COOKIE);
    expect((await h.api('/api/v1/admin/qoder/credits/history')).status).toBe(403);
    expect((await admin('/credits/history?page_size=101')).status).toBe(400);
    expect((await admin('/credits/history?order=up')).status).toBe(400);
    expect((await admin('/credits/history?start=2026-11-10&end=2026-11-01')).status).toBe(400);

    const res = (await (await admin('/credits/history?page=1&page_size=2&start=1794240000000&end=2026-11-16T23:59:59.999Z')).json()) as any;
    expect(Object.fromEntries(web.lastQuery)).toEqual({
      page: '1',
      page_size: '2',
      order_by: 'begin_at',
      order: '-1',
      start_time: '1794240000000',
      end_time: String(Date.parse('2026-11-16T23:59:59.999Z')),
    });
    expect(res).toMatchObject({
      status: 'ok',
      error: null,
      page: { current: 1, page_size: 2, last_page: 187, total_items: 373 },
      page_summary: { credits: 87.14, original_credits: 88.58, cost: 0.86, original_cost: 0.88 },
    });
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toEqual({
      begin_at: new Date(1794823948000).toISOString(),
      finish_at: new Date(1794823948000).toISOString(),
      session_id: 'sess_a',
      business_id: 'video_1',
      source: 'Cloud Agents',
      operation: 'Video',
      kind: 'Charged',
      model: 'Auto',
      credits: 85.71,
      original_credits: 85.71,
      cost: 0.85,
      original_cost: 0.85,
      discount_factor: 1,
    });

    await admin('/credits/history?order=asc');
    expect(web.lastQuery.get('order')).toBe('1');
    expect(web.lastQuery.has('start_time')).toBe(false);

    web.valid.clear();
    expect((await (await admin('/credits/history')).json()) as any).toMatchObject({ status: 'session_expired', items: [], page: null });
  });
});
