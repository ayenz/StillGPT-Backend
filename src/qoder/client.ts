import { AppError } from '../errors.js';
import type { Logger } from '../log.js';
import { parseSse } from './sse.js';
import type { TokenProvider } from './tokens.js';
import type {
  AgentModelRef,
  QoderAgent,
  QoderEvent,
  QoderFile,
  QoderInputEvent,
  QoderList,
  QoderModel,
  QoderSession,
  QoderStreamFrame,
  ToolsetConfig,
} from './types.js';

const SESSION_PATCH_BETA = 'session-agent-patch-2026-07-21';
const MODEL_UNAVAILABLE = /must reference an available model/i;

/** Upstream error, already mapped to a status/code our API layers understand. */
export class QoderApiError extends AppError {
  constructor(
    status: number,
    readonly upstreamType: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(status >= 500 || status === 429 ? 502 : status, mapCode(status, upstreamType, message), `Qoder: ${message}`, {
      upstreamStatus: status,
      upstreamType,
      requestId,
    });
  }

  get upstreamStatus(): number {
    return (this.details?.upstreamStatus as number) ?? 0;
  }
}

function mapCode(status: number, type: string, message: string): string {
  if (MODEL_UNAVAILABLE.test(message)) return 'model_unavailable';
  if (status === 401) return 'upstream_auth';
  if (status === 429 || status >= 500) return 'upstream_unavailable';
  if (status === 404) return 'upstream_not_found';
  if (status === 409) return 'upstream_conflict';
  return type || 'upstream_error';
}

export const isModelUnavailable = (err: unknown) =>
  err instanceof AppError && (err.code === 'model_unavailable' || MODEL_UNAVAILABLE.test(err.message));

export interface QoderClientOptions {
  baseUrl: string;
  tokens: TokenProvider;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Retries for 429/5xx/network errors (exponential backoff 1s → 2s → 4s). */
  maxRetries?: number;
  retryBaseMs?: number;
}

export interface StreamOptions {
  lastEventId?: string | null;
  deltas?: boolean;
  signal?: AbortSignal;
}

/** Thin typed wrapper over the Qoder Cloud Agents REST + SSE API. */
export class QoderClient {
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: QoderClientOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
  }

  // ── models / environments / agents ──────────────────────────────────────
  listModels = () => this.json<QoderList<QoderModel>>('GET', '/models').then((r) => r.data);
  listEnvironments = () => this.json<QoderList<{ id: string; name: string }>>('GET', '/environments?limit=100').then((r) => r.data);
  createEnvironment = (name: string) => this.json<{ id: string; name: string }>('POST', '/environments', { name });

  createAgent = (body: { name: string; model: AgentModelRef; system?: string; tools: ToolsetConfig[]; metadata?: Record<string, string> }) =>
    this.json<QoderAgent>('POST', '/agents', body);
  getAgent = (id: string) => this.json<QoderAgent>('GET', `/agents/${id}`);
  archiveAgent = (id: string) => this.json<unknown>('POST', `/agents/${id}/archive`);

  // ── sessions ────────────────────────────────────────────────────────────
  createSession = (body: {
    agent: string;
    environment_id: string;
    title?: string;
    metadata?: Record<string, string>;
    budget?: { type: 'limit'; max_credit_cost: string } | null;
  }) => this.json<QoderSession>('POST', '/sessions', body);
  getSession = (id: string) => this.json<QoderSession>('GET', `/sessions/${id}`);
  archiveSession = (id: string) => this.json<unknown>('POST', `/sessions/${id}/archive`);

  /** Change model / system prompt / tools of a live session (context is preserved). */
  updateSession = (id: string, patch: { agent?: { model?: AgentModelRef; system?: string; tools?: ToolsetConfig[] }; title?: string }) =>
    this.json<QoderSession>('POST', `/sessions/${id}`, patch, { 'x-qoder-beta': SESSION_PATCH_BETA });

  sendEvents = (sessionId: string, events: QoderInputEvent[]) =>
    this.json<unknown>('POST', `/sessions/${sessionId}/events`, { events }, undefined, { retry: false });

  listEvents = (sessionId: string, opts: { limit?: number; afterId?: string } = {}) => {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    if (opts.afterId) q.set('after_id', opts.afterId);
    return this.json<QoderList<QoderEvent>>('GET', `/sessions/${sessionId}/events?${q}`);
  };

  addFileResource = (sessionId: string, fileId: string, mountPath: string) =>
    this.json<{ id: string }>('POST', `/sessions/${sessionId}/resources`, { type: 'file', file_id: fileId, mount_path: mountPath });

  /**
   * Open the session event stream and resolve once the connection is established (so a message sent
   * afterwards cannot be missed — the stream does not replay without Last-Event-ID).
   * The returned iterator yields buffered events and delta frames (heartbeats dropped). The upstream
   * connection never closes on its own: stop iterating (or abort) when the turn is idle.
   */
  async openEventStream(sessionId: string, opts: StreamOptions = {}): Promise<AsyncGenerator<QoderStreamFrame>> {
    const q = opts.deltas ? '?event_deltas[]=agent.message' : '';
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    const res = await this.raw('GET', `/sessions/${sessionId}/events/stream${q}`, undefined, headers, { retry: true, signal: opts.signal });
    if (!res.body) throw new AppError(502, 'upstream_unavailable', 'Qoder stream has no body');
    return this.frames(res.body, sessionId, opts.signal);
  }

  private async *frames(body: ReadableStream<Uint8Array>, sessionId: string, signal?: AbortSignal): AsyncGenerator<QoderStreamFrame> {
    for await (const msg of parseSse(body, signal)) {
      if (msg.event === 'heartbeat' || !msg.data || msg.data === '{}') continue;
      let data: QoderEvent;
      try {
        data = JSON.parse(msg.data) as QoderEvent;
      } catch {
        this.opts.log.warn('qoder.stream.bad_json', { sessionId, data: msg.data.slice(0, 200) });
        continue;
      }
      yield { id: msg.id, event: msg.event, data };
    }
  }

  // ── files ───────────────────────────────────────────────────────────────
  async uploadFile(bytes: Uint8Array, filename: string, mimeType: string): Promise<QoderFile> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const res = await this.raw('POST', '/files', form, {}, { retry: true });
    return (await res.json()) as QoderFile;
  }
  getFile = (id: string) => this.json<QoderFile & { metadata?: Record<string, unknown> }>('GET', `/files/${id}`);
  getFileContentUrl = (id: string) => this.json<{ url: string; expires_at: string }>('GET', `/files/${id}/content`);

  async downloadFile(id: string): Promise<Buffer> {
    const { url } = await this.getFileContentUrl(id);
    const res = await this.fetch(url);
    if (!res.ok) throw new AppError(502, 'upstream_unavailable', `Downloading Qoder file ${id} failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ── transport ───────────────────────────────────────────────────────────
  private async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>, o?: { retry?: boolean }): Promise<T> {
    const res = await this.raw(method, path, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', ...headers }, {
      retry: o?.retry ?? true,
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async raw(
    method: string,
    path: string,
    body: BodyInit | undefined,
    headers: Record<string, string>,
    o: { retry: boolean; signal?: AbortSignal },
  ): Promise<Response> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.getToken();
      let res: Response;
      try {
        res = await this.fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, signal: o.signal });
      } catch (err) {
        if (o.signal?.aborted) throw err;
        if (o.retry && attempt < this.maxRetries) {
          await this.backoff(attempt, `${method} ${path}`, err);
          continue;
        }
        throw new AppError(502, 'upstream_unavailable', `Qoder unreachable: ${(err as Error).message}`);
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (o.retry && retryable && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.backoff(attempt, `${method} ${path}`, res.status);
        continue;
      }
      throw await toQoderError(res);
    }
  }

  private async backoff(attempt: number, what: string, cause: unknown) {
    const ms = this.retryBaseMs * 2 ** attempt;
    this.opts.log.warn('qoder.retry', { what, attempt: attempt + 1, waitMs: ms, cause: String(cause) });
    await new Promise((r) => setTimeout(r, ms));
  }
}

async function toQoderError(res: Response): Promise<QoderApiError> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { request_id?: string; error?: { type?: string; message?: string } };
    return new QoderApiError(res.status, body.error?.type ?? 'unknown', body.error?.message ?? text.slice(0, 300), body.request_id);
  } catch {
    return new QoderApiError(res.status, 'unknown', text.slice(0, 300) || res.statusText);
  }
}
