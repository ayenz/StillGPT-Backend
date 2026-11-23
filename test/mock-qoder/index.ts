/**
 * Deterministic in-process fake of the Qoder Cloud Agents API (docs/QODER_API_NOTES.md).
 *
 *   const qoder = await startMockQoder();
 *   const client = new QoderClient({ baseUrl: qoder.url, token: 'pt-test' });
 *   …
 *   await qoder.close();
 *
 * Notes on choices where the real API is unspecified:
 * - `session.usage` credits are cumulative for the session (budget checks compare against the same total).
 * - Ids are deterministic per instance (`evt_000001`, `sess_000001`, …) and sort in creation order.
 * - `Last-Event-ID` with an unknown id replays the whole buffer (never loses events).
 * - Delta / event_start frames are not buffered, so a resumed stream only gets the buffered `agent.message`.
 * - `[[error]]` terminates the session; later user.message posts get 409 conflict_error.
 * The scripted agent behaviour is documented in `script.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AgentObject,
  ApiError,
  type Budget,
  DEFAULT_MODELS,
  type EnvironmentObject,
  errorTypeForStatus,
  MockCore,
  type MockModel,
  type MockState,
  normalizeModel,
  nowIso,
  paginate,
  publicFile,
  publicSession,
  type QoderEvent,
  type RequestLogEntry,
  type ResourceObject,
  type SessionRecord,
  sseFrame,
  type Subscriber,
} from './core.js';
import { type ScriptOptions, TurnScript, userText } from './script.js';

export type { MockModel, MockState } from './core.js';
export { MODEL_UNAVAILABLE, KNOWN_TOOLS } from './core.js';
export { makePng, makeMp4 } from './media.js';

export interface MockQoderOptions {
  /** Accepted bearer token. Default `pt-test`. */
  token?: string;
  /** Initial model list. Default: auto, efficient, fast, ultimate, qfmodel, kmodel_latest, dfmodel. */
  models?: MockModel[];
  /** Characters per `event_delta` frame. Default 4. */
  deltaChunkSize?: number;
  /** Simulated VideoGen duration. Default 200 ms. */
  videoDelayMs?: number;
  /** Simulated ImageGen duration. Default 50 ms. */
  imageDelayMs?: number;
  /** Delay applied by the `[[slow]]` trigger. Default 1000 ms. */
  slowDelayMs?: number;
  /** SSE heartbeat interval. Default 15000 ms (the real API's ~15 s). */
  heartbeatMs?: number;
}

export interface MockQoder {
  /** Base URL to give QoderClient, e.g. `http://127.0.0.1:PORT/api/v1/cloud`. */
  url: string;
  close(): Promise<void>;
  state: MockState;
  retireModel(id: string): void;
  addModel(m: MockModel): void;
  renameModel(id: string, displayName: string): void;
  /** The next request whose pathname matches `path` gets `status` + `body` (default: an error envelope). */
  failNext(path: RegExp, status: number, body?: unknown): void;
  /** Override the scripted reply text for subsequent turns (undefined restores the default). */
  setReply(fn: ((text: string, modelId: string) => string | undefined) | undefined): void;
  /** Make ImageGen/VideoGen calls fail with the returned text (undefined restores success). */
  setToolError(fn: ((tool: 'ImageGen' | 'VideoGen', text: string) => string | undefined) | undefined): void;
  /** Change the accepted bearer token (simulates rotating the PAT upstream). */
  setToken(t: string): void;
  /** Deliver the returned files (DeliverArtifacts) on turns whose text matches (undefined restores none). */
  setFiles(fn: ((text: string) => { name: string; bytes: Buffer; mimeType: string }[] | undefined) | undefined): void;
}

const BASE = '/api/v1/cloud';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Returned by handlers that wrote the response themselves (SSE, downloads). */
const HANDLED = Symbol('handled');

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  raw: Buffer;
  log: RequestLogEntry;
}
type Reply = { status: number; body: unknown } | typeof HANDLED;
type Handler = (c: Ctx) => Reply | Promise<Reply>;

const ok = (body: unknown, status = 200): Reply => ({ status, body });

function bad(message: string, param?: string): never {
  throw new ApiError(400, 'invalid_request_error', message, param);
}

function jsonBody(c: Ctx): Record<string, unknown> {
  if (c.raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(c.raw.toString('utf8'));
  } catch {
    bad('Request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) bad('Request body must be a JSON object.');
  c.log.body = parsed;
  return parsed as Record<string, unknown>;
}

function optString(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== 'string') bad(`Field '${field}' must be a string.`, field);
  return v;
}

function metadataField(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) bad("Field 'metadata' must be an object.", 'metadata');
  return v as Record<string, string>;
}

function budgetField(v: unknown): Budget | null {
  if (v === undefined || v === null) return null;
  const b = v as Partial<Budget>;
  if (b.type !== 'limit' || Number.isNaN(Number(b.max_credit_cost))) {
    bad("Field 'budget' must be {type:'limit', max_credit_cost:'<decimal>'}.", 'budget');
  }
  return { type: 'limit', max_credit_cost: String(b.max_credit_cost) };
}

/** Collects the request body (bounded). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'invalid_request_error', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockQoder(opts: MockQoderOptions = {}): Promise<MockQoder> {
  let token = opts.token ?? 'pt-test';
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const core = new MockCore(opts.models ?? DEFAULT_MODELS);
  const scriptOpts: ScriptOptions = {
    deltaChunkSize: opts.deltaChunkSize ?? 4,
    videoDelayMs: opts.videoDelayMs ?? 200,
    imageDelayMs: opts.imageDelayMs ?? 50,
    slowDelayMs: opts.slowDelayMs ?? 1000,
  };
  const script = new TurnScript(core, scriptOpts);
  const { state } = core;
  const failures: Array<{ path: RegExp; status: number; body?: unknown }> = [];
  const streams = new Set<ServerResponse>();
  let origin = '';

  // ------------------------------------------------------------------ routes
  const routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_m, k: string) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  };

  // Models -------------------------------------------------------------------
  route('GET', `${BASE}/models`, () => {
    const data = [...state.models.values()].filter((r) => r.active).map((r) => r.model);
    return ok({ data, has_more: false });
  });

  // Environments -------------------------------------------------------------
  route('GET', `${BASE}/environments`, (c) => ok(paginate([...state.environments.values()], c.url.searchParams)));
  route('POST', `${BASE}/environments`, (c) => {
    const body = jsonBody(c);
    if (typeof body.name !== 'string' || !body.name) bad("Field 'name' is required.", 'name');
    const now = nowIso();
    const env: EnvironmentObject = {
      id: core.nextId('env'),
      type: 'environment',
      name: body.name,
      description: optString(body.description, 'description') ?? null,
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
      metadata: metadataField(body.metadata),
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    state.environments.set(env.id, env);
    return ok(env);
  });

  // Agents -------------------------------------------------------------------
  const getAgent = (id: string): AgentObject => {
    const a = state.agents.get(id);
    if (!a) throw new ApiError(404, 'not_found_error', `Agent ${id} not found.`);
    return a;
  };
  route('GET', `${BASE}/agents`, (c) => ok(paginate([...state.agents.values()], c.url.searchParams)));
  route('POST', `${BASE}/agents`, (c) => {
    const body = jsonBody(c);
    if (typeof body.name !== 'string' || !body.name) bad("Field 'name' is required.", 'name');
    const { ref } = core.resolveModelRef(body.model);
    const tools = core.validateTools(body.tools);
    const now = nowIso();
    const agent: AgentObject = {
      id: core.nextId('agent'),
      type: 'agent',
      name: body.name,
      description: optString(body.description, 'description') ?? null,
      model: ref,
      system: optString(body.system, 'system') ?? null,
      tools,
      metadata: metadataField(body.metadata),
      version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    state.agents.set(agent.id, agent);
    return ok(agent);
  });
  route('GET', `${BASE}/agents/:id`, (c) => ok(getAgent(c.params.id!)));
  route('POST', `${BASE}/agents/:id/archive`, (c) => {
    const a = getAgent(c.params.id!);
    a.archived_at ??= nowIso();
    a.updated_at = nowIso();
    return ok(a);
  });

  // Sessions -----------------------------------------------------------------
  const mountResource = (s: SessionRecord, input: unknown): ResourceObject => {
    const r = (input ?? {}) as Record<string, unknown>;
    if (r.type !== 'file') bad("Resource 'type' must be 'file'.", 'type');
    if (typeof r.file_id !== 'string') bad("Field 'file_id' is required.", 'file_id');
    if (typeof r.mount_path !== 'string' || !r.mount_path.startsWith('/')) {
      bad("Field 'mount_path' must be an absolute path.", 'mount_path');
    }
    core.getFile(r.file_id);
    const res: ResourceObject = {
      id: core.nextId('sesr'),
      type: 'file',
      file_id: r.file_id,
      mount_path: r.mount_path,
      created_at: nowIso(),
    };
    s.resources.push(res);
    return res;
  };

  route('POST', `${BASE}/sessions`, (c) => {
    const body = jsonBody(c);
    const agentId =
      typeof body.agent === 'string' ? body.agent : (body.agent as { id?: unknown } | undefined)?.id;
    if (typeof agentId !== 'string') bad("Field 'agent' is required.", 'agent');
    const agent = getAgent(agentId);
    if (agent.archived_at) bad(`Agent ${agent.id} is archived.`, 'agent');
    if (typeof body.environment_id !== 'string') bad("Field 'environment_id' is required.", 'environment_id');
    if (!state.environments.has(body.environment_id)) {
      throw new ApiError(404, 'not_found_error', `Environment ${body.environment_id} not found.`);
    }
    // The snapshot model must still exist (an agent may outlive its model).
    const { ref, model } = core.resolveModelRef(agent.model);
    const now = nowIso();
    const s: SessionRecord = {
      id: core.nextId('sess'),
      status: 'idle',
      title: optString(body.title, 'title') ?? null,
      metadata: metadataField(body.metadata),
      budget: budgetField(body.budget),
      agent: {
        id: agent.id,
        name: agent.name,
        model: { ...ref, effective_context_window: model.default_context_window },
        system: agent.system,
        tools: agent.tools,
        version: agent.version,
      },
      environment_id: body.environment_id,
      created_at: now,
      updated_at: now,
      archived_at: null,
      events: [],
      resources: [],
      userTexts: [],
      credits: 0,
      activeMs: 0,
      turn: null,
      subscribers: new Set(),
    };
    if (body.resources !== undefined) {
      if (!Array.isArray(body.resources)) bad("Field 'resources' must be an array.", 'resources');
      for (const r of body.resources) mountResource(s, r);
    }
    state.sessions.set(s.id, s);
    return ok(publicSession(s));
  });

  route('GET', `${BASE}/sessions`, (c) => {
    const agentId = c.url.searchParams.get('agent_id');
    const all = [...state.sessions.values()].filter((s) => !agentId || s.agent.id === agentId);
    const page = paginate(all, c.url.searchParams);
    return ok({ ...page, data: (page.data as SessionRecord[]).map(publicSession) });
  });
  route('GET', `${BASE}/sessions/:id`, (c) => ok(publicSession(core.getSession(c.params.id!))));

  // Update: agent.{model,system,tools}, title, metadata (merged; null deletes a key), budget.
  route('POST', `${BASE}/sessions/:id`, (c) => {
    const s = core.getSession(c.params.id!);
    const body = jsonBody(c);
    if (body.agent !== undefined) {
      const patch = body.agent as Record<string, unknown>;
      if (!patch || typeof patch !== 'object') bad("Field 'agent' must be an object.", 'agent');
      if (patch.model !== undefined) {
        const { ref, model } = core.resolveModelRef(patch.model);
        s.agent.model = { ...ref, effective_context_window: model.default_context_window };
      }
      if (patch.system !== undefined) s.agent.system = optString(patch.system, 'agent.system') ?? null;
      if (patch.tools !== undefined) s.agent.tools = core.validateTools(patch.tools);
    }
    if (body.title !== undefined) s.title = optString(body.title, 'title') ?? null;
    if (body.metadata !== undefined) {
      for (const [k, v] of Object.entries(metadataField(body.metadata))) {
        if (v === null) delete s.metadata[k];
        else s.metadata[k] = v;
      }
    }
    if (body.budget !== undefined) s.budget = budgetField(body.budget);
    s.updated_at = nowIso();
    return ok(publicSession(s));
  });
  route('POST', `${BASE}/sessions/:id/archive`, (c) => {
    const s = core.getSession(c.params.id!);
    s.archived_at ??= nowIso();
    s.turn?.controller.abort();
    s.status = 'terminated';
    s.updated_at = nowIso();
    return ok(publicSession(s));
  });
  route('DELETE', `${BASE}/sessions/:id`, (c) => {
    const s = core.getSession(c.params.id!);
    s.turn?.controller.abort();
    state.sessions.delete(s.id);
    return ok({ id: s.id, type: 'session_deleted' });
  });

  // Resources ----------------------------------------------------------------
  route('POST', `${BASE}/sessions/:id/resources`, (c) => ok(mountResource(core.getSession(c.params.id!), jsonBody(c))));
  route('GET', `${BASE}/sessions/:id/resources`, (c) =>
    ok(paginate(core.getSession(c.params.id!).resources, c.url.searchParams, 100)),
  );

  // Events -------------------------------------------------------------------
  const validateContent = (content: unknown): void => {
    if (!Array.isArray(content) || content.length === 0) {
      bad("Field 'content' must be a non-empty array.", 'content');
    }
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'text') {
        if (typeof block.text !== 'string') bad("Text blocks require 'text'.", 'content');
      } else if (block?.type === 'image') {
        const src = block.source as Record<string, unknown> | undefined;
        if (src?.type === 'base64') {
          if (typeof src.data !== 'string' || typeof src.media_type !== 'string') {
            bad("Base64 image sources require 'media_type' and 'data'.", 'content');
          }
        } else if (src?.type === 'url') {
          if (typeof src.url !== 'string') bad("URL image sources require 'url'.", 'content');
        } else if (src?.type === 'file') {
          if (typeof src.file_id !== 'string') bad("File image sources require 'file_id'.", 'content');
          core.getFile(src.file_id);
        } else {
          bad('Unsupported image source type.', 'content');
        }
      } else {
        bad(`Unsupported content block type '${String(block?.type)}'.`, 'content');
      }
    }
  };

  const startTurn = (s: SessionRecord, userEvent: QoderEvent) => {
    const controller = new AbortController();
    const turn = { controller, startedAt: Date.now() };
    s.turn = turn;
    s.status = 'running';
    script
      .run(s, userEvent, controller.signal)
      .catch((err: unknown) => {
        // Never let a scripting bug hang a test: surface it as a session error.
        core.appendEvent(s, 'session.error', { error: { type: 'api_error', message: String(err) } });
        s.status = 'idle';
        core.appendEvent(s, 'session.status_idle', { stop_reason: { type: 'end_turn' } });
      })
      .finally(() => {
        s.activeMs += Date.now() - turn.startedAt;
        if (s.turn === turn) s.turn = null;
      });
  };

  route('POST', `${BASE}/sessions/:id/events`, (c) => {
    const s = core.getSession(c.params.id!);
    const body = jsonBody(c);
    if (!Array.isArray(body.events) || body.events.length === 0) bad("Field 'events' must be a non-empty array.", 'events');
    if (s.archived_at) bad(`Session ${s.id} is archived.`);
    const created: QoderEvent[] = [];
    for (const e of body.events as Array<Record<string, unknown>>) {
      if (e?.type === 'user.message') {
        validateContent(e.content);
        if (s.status === 'terminated') throw new ApiError(409, 'conflict_error', `Session ${s.id} is terminated.`);
        if (s.turn) throw new ApiError(409, 'conflict_error', `Session ${s.id} is already running a turn.`);
        const content = e.content as Array<{ type: string; text?: string }>;
        s.userTexts.push(userText(content));
        const evt = core.appendEvent(s, 'user.message', { content });
        created.push(evt);
        startTurn(s, evt);
      } else if (e?.type === 'user.interrupt') {
        created.push(core.appendEvent(s, 'user.interrupt'));
        s.turn?.controller.abort();
      } else {
        bad(`Unsupported event type '${String(e?.type)}'.`, 'events');
      }
    }
    return ok({ data: created });
  });

  route('GET', `${BASE}/sessions/:id/events`, (c) =>
    ok(paginate(core.getSession(c.params.id!).events, c.url.searchParams, 100)),
  );

  route('GET', `${BASE}/sessions/:id/events/stream`, (c) => {
    const s = core.getSession(c.params.id!);
    const q = c.url.searchParams;
    const deltas = new Set(
      [...q.getAll('event_deltas[]'), ...q.getAll('event_deltas')].flatMap((v) => v.split(',')).filter(Boolean),
    );
    const res = c.res;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();

    // Resume: replay buffered events after Last-Event-ID. Without it nothing is replayed.
    const lastId = c.req.headers['last-event-id'];
    if (typeof lastId === 'string' && lastId) {
      const idx = s.events.findIndex((e) => e.id === lastId);
      for (const e of s.events.slice(idx + 1)) res.write(sseFrame(e.id, e.type, e));
    }

    const sub: Subscriber = { deltas, write: (frame) => res.write(frame) };
    s.subscribers.add(sub);
    streams.add(res);
    const heartbeat = setInterval(() => res.write(sseFrame(undefined, 'heartbeat', {})), heartbeatMs);
    // Like the real API the stream never ends on its own; it lives until the client goes away.
    res.on('close', () => {
      clearInterval(heartbeat);
      s.subscribers.delete(sub);
      streams.delete(res);
    });
    return HANDLED;
  });

  // Files --------------------------------------------------------------------
  route('POST', `${BASE}/files`, async (c) => {
    const ct = c.req.headers['content-type'] ?? '';
    if (!ct.startsWith('multipart/form-data')) bad('Expected multipart/form-data with a "file" field.');
    c.log.body = '<multipart>';
    let form: FormData;
    try {
      form = await new Request('http://mock/upload', { method: 'POST', headers: { 'content-type': ct }, body: new Uint8Array(c.raw) }).formData();
    } catch {
      bad('Malformed multipart body.');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') bad("Multipart field 'file' is required.", 'file');
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) bad('File exceeds the maximum size of 5 MB.', 'file');
    const name = form.get('name');
    const created = core.createFile({
      filename: typeof name === 'string' && name ? name : file.name || 'upload',
      bytes,
      mimeType: file.type || 'application/octet-stream',
    });
    return ok(publicFile(created));
  });
  route('GET', `${BASE}/files`, (c) => ok(paginate([...state.files.values()].map(publicFile), c.url.searchParams)));
  route('GET', `${BASE}/files/:id`, (c) => ok(publicFile(core.getFile(c.params.id!))));
  // Like Qoder: a file mounted in (or produced by) a non-archived session cannot be deleted.
  route('DELETE', `${BASE}/files/:id`, (c) => {
    const f = core.getFile(c.params.id!);
    const refs = [...state.sessions.values()]
      .filter((s) => !s.archived_at && (s.resources.some((r) => r.file_id === f.id) || f.scope?.id === s.id))
      .map((s) => s.id);
    if (refs.length) throw new ApiError(409, 'invalid_request_error', 'File is referenced by an active session and cannot be deleted.');
    state.files.delete(f.id);
    return ok({ id: f.id, type: 'file_deleted' });
  });
  route('GET', `${BASE}/files/:id/content`, (c) => {
    const f = core.getFile(c.params.id!);
    if (!f.downloadable) throw new ApiError(403, 'permission_error', `File ${f.id} is not downloadable.`);
    return ok({
      url: `${origin}/_download/${f.id}?signature=mock`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  });
  // "Presigned" download target: no bearer auth, like an S3 URL.
  route('GET', '/_download/:id', (c) => {
    const f = core.getFile(c.params.id!);
    c.res.writeHead(200, { 'content-type': f.mime_type, 'content-length': String(f.bytes.length) });
    c.res.end(f.bytes);
    return HANDLED;
  });

  // ------------------------------------------------------------------ dispatch
  const sendError = (res: ServerResponse, log: RequestLogEntry, err: ApiError) => {
    const body = {
      type: 'error',
      request_id: core.nextRequestId(),
      error: { type: err.type, message: err.message, ...(err.param ? { param: err.param } : {}) },
    };
    log.status = err.status;
    if (!res.headersSent) res.writeHead(err.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    const pick = (h: string) => req.headers[h];
    const headers: Record<string, string> = {};
    for (const h of ['authorization', 'content-type', 'x-qoder-beta', 'last-event-id']) {
      const v = pick(h);
      if (typeof v === 'string') headers[h] = v;
    }
    const log: RequestLogEntry = {
      at: nowIso(),
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      headers,
      body: undefined,
      status: 0,
    };
    state.requestLog.push(log);

    try {
      const raw = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

      const fIdx = failures.findIndex((f) => f.path.test(url.pathname));
      if (fIdx !== -1) {
        const [f] = failures.splice(fIdx, 1);
        log.status = f!.status;
        res.writeHead(f!.status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            f!.body ?? {
              type: 'error',
              request_id: core.nextRequestId(),
              error: { type: errorTypeForStatus(f!.status), message: `Injected failure (${f!.status}).` },
            },
          ),
        );
        return;
      }

      // Everything except the "presigned" download route needs the bearer token (checked before routing, so
      // unknown paths without a token are 401 as well).
      if (!url.pathname.startsWith('/_download/') && req.headers.authorization !== `Bearer ${token}`) {
        throw new ApiError(401, 'authentication_error', 'Invalid or missing bearer token.');
      }

      let match: { r: (typeof routes)[number]; m: RegExpExecArray } | undefined;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) {
          match = { r, m };
          break;
        }
      }
      if (!match) {
        throw new ApiError(
          404,
          'not_found_error',
          pathMatched ? `Method ${req.method} not allowed on ${url.pathname}.` : `Route ${url.pathname} not found.`,
        );
      }
      const params: Record<string, string> = {};
      match.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m[i + 1]!)));
      const reply = await match.r.handler({ req, res, url, params, raw, log });
      if (reply === HANDLED) {
        log.status = res.statusCode;
        return;
      }
      log.status = reply.status;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    } catch (err) {
      sendError(res, log, err instanceof ApiError ? err : new ApiError(500, 'api_error', String(err)));
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));
  server.timeout = 0; // SSE streams are long-lived
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}${BASE}`,
    state,
    async close() {
      for (const s of state.sessions.values()) s.turn?.controller.abort();
      for (const res of streams) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    setReply(fn) {
      scriptOpts.reply = fn;
    },
    setToolError(fn) {
      scriptOpts.toolError = fn;
    },
    setToken(t) {
      token = t;
    },
    setFiles(fn) {
      scriptOpts.files = fn;
    },
    retireModel(id) {
      const rec = state.models.get(id);
      if (!rec) throw new Error(`mock-qoder: unknown model ${id}`);
      rec.active = false;
    },
    addModel(m) {
      state.models.set(m.id, { model: normalizeModel(m), active: true });
    },
    renameModel(id, displayName) {
      const rec = state.models.get(id);
      if (!rec) throw new Error(`mock-qoder: unknown model ${id}`);
      rec.model.display_name = displayName;
    },
    failNext(path, status, body) {
      failures.push({ path, status, body });
    },
  };
}
