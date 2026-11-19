import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_FOLAX_KEY = 'folax-test-key';
/** Smallest thing that starts like a JPEG; the store does not decode images. */
export const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

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
    editsDone: 0,
    editDelayMs: 0,
    /** GET /v1/videos/{id} answers `processing` this many times, then `succeeded` (or `videoFail`). */
    videoPolls: 2,
    videoFail: null as null | { code: string; message: string },
  };
  interface FakeVideo {
    id: string;
    key?: string;
    taskId: string;
    clientTaskId: string;
    prompt: string;
    polls: number;
  }
  /** Adapter memory (cleared by `restart()`); tasks survive like upstream does. */
  const videos = new Map<string, FakeVideo>();
  const videoKeys = new Map<string, string>();
  let videoSeq = 0;
  const videoView = (v: FakeVideo) => {
    const done = v.polls >= state.videoPolls;
    const status = !done ? (v.polls === 0 ? 'queued' : 'processing') : state.videoFail ? 'failed' : 'succeeded';
    return {
      id: v.id,
      object: 'video',
      status,
      progress: done ? 100 : v.polls * 30,
      quota_remaining: status === 'succeeded' ? 11 : null,
      upstream: { task_id: v.taskId, client_task_id: v.clientTaskId },
      error: status === 'failed' ? state.videoFail : null,
    };
  };
  type Reply = [number, unknown, Record<string, string>?] | [number, Buffer, Record<string, string>, 'raw'];
  type Handler = (req: IncomingMessage, body: unknown, url: URL, params: string[]) => Promise<Reply> | Reply;
  const routes = new Map<string, Handler>();
  /** `METHOD regex` routes, tried after the exact ones. */
  const patterns: [string, RegExp, Handler][] = [];
  const notFound: Reply = [404, { error: { message: 'job tidak ditemukan', type: 'invalid_request_error', code: 'not_found', param: null } }];

  routes.set('POST /v1/videos', (req, body) => {
    const b = body as { image?: string; prompt?: string };
    const key = req.headers['idempotency-key'] as string | undefined;
    const known = key ? videoKeys.get(key) : undefined;
    if (known) {
      // the adapter keeps keyed jobs on disk: a replay after a restart recreates the same id from the task
      let v = videos.get(known);
      if (!v) {
        v = tasks.get(known)!;
        videos.set(v.id, v);
      }
      return [202, videoView(v), { 'Idempotent-Replayed': 'true' }];
    }
    if (!b?.image) return [400, { error: { message: 'gambar tidak valid', type: 'invalid_request_error', code: 'invalid_image', param: 'image' } }];
    videoSeq++;
    const v: FakeVideo = { id: `video_${videoSeq}`, key, taskId: `cgt-${videoSeq}`, clientTaskId: `ct-${videoSeq}`, prompt: b.prompt ?? '', polls: 0 };
    videos.set(v.id, v);
    tasks.set(v.id, v);
    if (key) videoKeys.set(key, v.id);
    return [202, videoView(v)];
  });
  const tasks = new Map<string, FakeVideo>();
  routes.set('POST /v1/videos/resume', (_req, body) => {
    const b = body as { task_id?: string; client_task_id?: string };
    const task = [...tasks.values()].find((t) => t.taskId === b?.task_id);
    if (!task) return [200, { id: `video_r${++videoSeq}`, object: 'video', status: 'failed', progress: 0, upstream: { task_id: b?.task_id, client_task_id: b?.client_task_id }, error: { code: 'upstream_task_failed', message: 'Video generation failed' } }];
    const v: FakeVideo = { ...task, id: `video_r${++videoSeq}` };
    videos.set(v.id, v);
    return [200, videoView(v)];
  });
  patterns.push([
    'GET',
    /^\/v1\/videos\/([^/]+)$/,
    (_req, _b, _u, [id]) => {
      const v = videos.get(id!);
      if (!v) return notFound;
      v.polls++;
      return [200, videoView(v)];
    },
  ]);
  patterns.push([
    'GET',
    /^\/v1\/videos\/([^/]+)\/content$/,
    (_req, _b, _u, [id]) => {
      const v = videos.get(id!);
      if (!v) return notFound;
      if (videoView(v).status !== 'succeeded') return [409, { error: { message: 'video belum siap', type: 'invalid_request_error', code: 'not_ready', param: null } }];
      return [200, FAKE_MP4, { 'content-type': 'video/mp4' }, 'raw'];
    },
  ]);

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

  /** POST /v1/images/edits (JSON): echoes a small JPEG; replays by Idempotency-Key like the adapter. */
  const editReplies = new Map<string, unknown>();
  routes.set('POST /v1/images/edits', async (req, body) => {
    const b = body as { mode?: string; prompt?: string; image?: string };
    const key = req.headers['idempotency-key'] as string | undefined;
    if (key && editReplies.has(key)) return [200, editReplies.get(key), { 'Idempotent-Replayed': 'true' }];
    // one-shot delay (to make the client time out once)
    const delay = state.editDelayMs;
    state.editDelayMs = 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (!b?.image || !Buffer.from(b.image, 'base64').length) return [400, { error: { message: 'gambar tidak valid', type: 'invalid_request_error', code: 'invalid_image', param: 'image' } }];
    if (b.mode !== 'instruction' && b.mode !== 'remove_people') return [422, { error: { message: 'mode', type: 'invalid_request_error', code: 'unsupported_request', param: 'mode' } }];
    state.editsDone++;
    const reply = {
      request_id: `req_${state.editsDone}`,
      mode: b.mode,
      images: [{ file_name: `folax-edit-${state.editsDone}.jpg`, mime_type: 'image/jpeg', width: 640, height: 480, data: FAKE_JPEG.toString('base64') }],
      usage: b.mode === 'instruction' ? { used: state.editsDone, total: 20, remaining: 20 - state.editsDone, reset_at: '2026-11-23T00:00:00Z', cycle: 'weekly' } : null,
      reply: 'Image processing complete~',
      elapsed_seconds: 1,
    };
    if (key) editReplies.set(key, reply);
    return [200, reply];
  });

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
      let handler = routes.get(key);
      let params: string[] = [];
      if (!handler) {
        for (const [method, re, h] of patterns) {
          const m = method === req.method ? re.exec(url.pathname) : null;
          if (m) {
            handler = h;
            params = m.slice(1);
            break;
          }
        }
      }
      if (!handler) return reply(404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found', param: null } });
      const [status, payload, headers, isRaw] = await handler(req, body, url, params);
      if (isRaw) return (res as ServerResponse).writeHead(status, headers).end(payload);
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
      state.editsDone = 0;
      state.editDelayMs = 0;
      state.videoPolls = 2;
      state.videoFail = null;
      editReplies.clear();
      videos.clear();
      videoKeys.clear();
      tasks.clear();
      videoSeq = 0;
    },
    /** Adapter restart: in-memory jobs are gone (keyed ones come back on a POST replay), upstream tasks stay. */
    restart() {
      videos.clear();
    },
    videoCount: () => videoSeq,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeFolax = Awaited<ReturnType<typeof startFakeFolax>>;
