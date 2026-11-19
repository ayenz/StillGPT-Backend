import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_FOLAX_KEY = 'folax-test-key';

export interface FakeFolaxCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Scripted {
  status: number;
  code: string;
  message?: string;
  headers?: Record<string, string>;
}

const quota = (remaining: number | null, source: string) => ({
  total: 20,
  remaining,
  reset_at: '2026-11-23T00:00:00Z',
  cycle: 'weekly',
  observed_at: remaining === null ? null : '2026-11-19T10:00:00Z',
  source,
});

/**
 * Fake folax-adapter v0.5 (OpenAI-style errors): /health/upstream, /v1/usage. `failNext(path, …)` scripts the next reply
 * of a path as an adapter error. Later stages add their endpoints to `routes`.
 */
export async function startFakeFolax() {
  const calls: FakeFolaxCall[] = [];
  const failures = new Map<string, Scripted[]>();
  const state = {
    upstream: { status: 'ok' as 'ok' | 'degraded' | 'down', errorCode: null as string | null },
    usage: { video: quota(12, 'observed'), edit: quota(null, 'unknown') } as Record<string, unknown>,
  };
  type Handler = (req: IncomingMessage, body: unknown, url: URL) => Promise<[number, unknown, Record<string, string>?]> | [number, unknown, Record<string, string>?];
  const routes = new Map<string, Handler>();

  routes.set('GET /health/upstream', () => {
    const u = state.upstream;
    const down = u.status === 'down';
    return [
      down ? 503 : 200,
      {
        status: u.status,
        checked_at: new Date().toISOString(),
        latency_ms: 1500,
        cached: false,
        token: { accepted: !(down && u.errorCode === 'auth_invalid'), jwt_expires_at: '2026-11-09T02:59:33Z', jwt_expired: true },
        error: u.errorCode ? { message: u.errorCode, type: 'api_error', code: u.errorCode, param: null } : null,
      },
    ];
  });
  routes.set('GET /v1/usage', () => [200, { object: 'usage', ...state.usage }]);

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const key = `${req.method} ${url.pathname}`;
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* keep raw */
      }
      calls.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body });
      const reply = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
        (res as ServerResponse).writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));
      if (req.headers['x-api-key'] !== FAKE_FOLAX_KEY) return reply(401, { error: { message: 'API key tidak valid', type: 'authentication_error', code: 'unauthorized', param: null } });
      const scripted = failures.get(key)?.shift();
      if (scripted)
        return reply(scripted.status, { error: { message: scripted.message ?? scripted.code, type: 'api_error', code: scripted.code, param: null } }, scripted.headers);
      const handler = routes.get(key);
      if (!handler) return reply(404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found', param: null } });
      const [status, payload, headers] = await handler(req, body, url);
      reply(status, payload, headers);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    key: FAKE_FOLAX_KEY,
    calls,
    state,
    routes,
    quota,
    /** The next request to `METHOD /path` gets this adapter error. */
    failNext(route: string, status: number, code: string, headers?: Record<string, string>, message?: string) {
      const list = failures.get(route) ?? [];
      list.push({ status, code, headers, message });
      failures.set(route, list);
    },
    callsTo: (route: string) => calls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === route),
    reset() {
      calls.length = 0;
      failures.clear();
      state.upstream = { status: 'ok', errorCode: null };
      state.usage = { video: quota(12, 'observed'), edit: quota(null, 'unknown') };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeFolax = Awaited<ReturnType<typeof startFakeFolax>>;
