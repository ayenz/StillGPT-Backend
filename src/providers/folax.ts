import { AppError } from '../errors.js';
import type { Logger } from '../log.js';

/** Ratios the Folax adapter accepts (config/service.yaml `allowed_ratios`). */
export const FOLAX_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type FolaxRatio = (typeof FOLAX_RATIOS)[number];
export const FOLAX_PROMPT_MAX = 1500;

export interface FolaxImage {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface FolaxOptions {
  /** Base URL of the folax-adapter sidecar, e.g. http://folax-adapter:8080 */
  baseUrl: string;
  apiKey: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Adapter waits up to 120 s upstream + grace; keep a little above that. */
  timeoutMs?: number;
  /** Calls in flight at once; later calls wait in FIFO order. Keep ≤ the adapter's `max_concurrency`. Default 8. */
  concurrency?: number;
  /** How long `/health/upstream` and `/v1/usage` results are reused. Default 60 s (the adapter caches as long). */
  statusCacheMs?: number;
}

/** `GET /health/upstream`: does Folax still accept the shared account token? `down` = every Folax feature fails. */
export interface FolaxUpstream {
  status: 'ok' | 'degraded' | 'down';
  checked_at: string;
  latency_ms: number | null;
  /** null when the adapter could not be reached at all. */
  token: { accepted: boolean; jwt_expires_at: string | null; jwt_expired: boolean | null } | null;
  /** `auth_invalid` / `not_configured` (down), `upstream_timeout` / `upstream_error` (degraded), `unreachable` (adapter down). */
  error: { code: string; message: string } | null;
}

/** One weekly quota bucket of `GET /v1/usage`. `remaining` is an upper bound (the account is also used on a phone). */
export interface FolaxQuota {
  total: number;
  remaining: number | null;
  reset_at: string;
  cycle: string;
  observed_at: string | null;
  /** `observed` this cycle, `reset` (no observation since the reset → full), `unknown` (never observed). */
  source: 'observed' | 'reset' | 'unknown';
}

export interface FolaxUsage {
  video: FolaxQuota;
  edit: FolaxQuota;
}

/** Edit modes StillGPT uses (the adapter's `style`/`portrait`/`expand`/`instruction_ids` are not part of the product). */
export const FOLAX_EDIT_MODES = ['instruction', 'remove_people'] as const;
export type FolaxEditMode = (typeof FOLAX_EDIT_MODES)[number];

interface FolaxEditResponse {
  images?: { file_name?: string; mime_type?: string; width?: number; height?: number; data?: string }[];
}

export interface FolaxEditResult extends FolaxImage {
  width: number | null;
  height: number | null;
  /** The adapter answered from its idempotency store (a retry of an earlier call). */
  replayed: boolean;
}

/** An adapter video job (`/v1/videos`). Output: always ~5 s, 720p, no audio, aspect of the input image, vendor watermark. */
export interface FolaxVideoJob {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  progress?: number;
  quota_remaining?: number | null;
  upstream?: { task_id?: string | null; client_task_id?: string | null };
  error?: { code?: string; message?: string } | null;
}

/** Adapter error codes (OpenAI envelope `error.code`, v0.4+) → our AppError. */
const API_ERRORS: Record<string, { status: number; code: string; message?: string }> = {
  quota_exceeded: { status: 429, code: 'folax_quota_exceeded', message: 'The weekly Folax quota is used up' },
  queue_timeout: { status: 429, code: 'provider_busy', message: 'Folax is busy; try again shortly' },
  too_many_jobs: { status: 429, code: 'provider_busy', message: 'Folax is busy; try again shortly' },
  auth_invalid: { status: 503, code: 'provider_unavailable', message: 'Folax is unavailable right now' },
  not_configured: { status: 503, code: 'provider_unavailable', message: 'Folax is unavailable right now' },
  invalid_image: { status: 400, code: 'invalid_image' },
  content_rejected: { status: 422, code: 'content_rejected' },
  image_rejected: { status: 422, code: 'image_rejected' },
  unsupported_request: { status: 422, code: 'unsupported_request' },
  model_not_found: { status: 400, code: 'model_not_found' },
  upstream_timeout: { status: 504, code: 'folax_timeout', message: 'Folax timed out' },
  not_found: { status: 404, code: 'folax_not_found' },
  not_ready: { status: 409, code: 'folax_not_ready' },
};

/** Adapter codes meaning Folax as a whole is down (token rejected / missing). */
const DOWN_CODES = new Set(['auth_invalid', 'not_configured']);

/**
 * Maps an adapter error reply (`{error:{message,type,code,param}}`) to an AppError. `details.folax_code` keeps the adapter's
 * code, `details.retry_after` (seconds) the `Retry-After` header. Unknown codes (upstream_task_failed, upstream_error,
 * idempotency_key_reused, invalid_request, …) become 502 `folax_failed`.
 */
export function folaxError(status: number, body: unknown, retryAfter?: string | null): AppError {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const folaxCode = typeof e?.code === 'string' ? e.code : status === 401 ? 'unauthorized' : `http_${status}`;
  const upstreamMessage = typeof e?.message === 'string' && e.message ? e.message : `HTTP ${status}`;
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const details: Record<string, unknown> = { provider: 'folax', folax_code: folaxCode, ...(Number.isFinite(seconds) && seconds >= 0 ? { retry_after: seconds } : {}) };
  // 401 = the adapter rejected OUR key (misconfiguration), not the Folax token
  if (status === 401) return new AppError(503, 'provider_unavailable', 'Folax is unavailable right now (adapter rejected the API key)', details);
  const known = API_ERRORS[folaxCode];
  if (known) return new AppError(known.status, known.code, known.message ? `${known.message} (${upstreamMessage})` : upstreamMessage, details);
  return new AppError(502, 'folax_failed', `Folax: ${upstreamMessage}`, details);
}

/**
 * Client for the Folax image adapter (Python sidecar wrapping the Folax ImageGenerationAgent).
 * Fast (~10 s per call) and returns 2 images per prompt, but only 5 ratios. Upstream takes parallel calls
 * (benchmarked: 16 at once still ~11 s each), so up to `concurrency` calls run together; the rest wait in FIFO order.
 */
export class FolaxClient {
  private readonly fetch: typeof fetch;
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly o: FolaxOptions) {
    this.fetch = o.fetchImpl ?? fetch;
    this.limit = Math.max(1, o.concurrency ?? 8);
  }

  async generate(prompt: string, ratio: FolaxRatio): Promise<FolaxImage[]> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await this.request(prompt, ratio);
    } finally {
      // hand the slot straight to the next waiter (active stays the same), or free it
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async request(prompt: string, ratio: FolaxRatio): Promise<FolaxImage[]> {
    const text = prompt.trim().slice(0, FOLAX_PROMPT_MAX);
    let res: Response;
    try {
      res = await this.fetch(`${this.o.baseUrl.replace(/\/$/, '')}/v1/images/generate-all`, {
        method: 'POST',
        headers: { 'X-API-Key': this.o.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, ratio }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 150_000),
      });
    } catch (err) {
      throw new AppError(502, 'folax_unavailable', `Folax adapter unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // adapter errors are FastAPI `{detail: "<CATEGORY>"}`: AUTH_INVALID, UPSTREAM_TIMEOUT, UPSTREAM_PROTOCOL_CHANGED, …
      const detail = await res
        .json()
        .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)))
        .catch(() => res.statusText);
      this.o.log.warn('folax.failed', { status: res.status, detail });
      const code = detail === 'AUTH_INVALID' ? 'folax_auth_invalid' : res.status === 504 ? 'folax_timeout' : 'folax_failed';
      throw new AppError(res.status === 422 ? 400 : 502, code, `Folax: ${detail}`);
    }
    const body = (await res.json()) as { images?: { file_name: string; mime_type: string; data: string }[] };
    const images = (body.images ?? []).map((i) => ({ filename: i.file_name, mimeType: i.mime_type, bytes: Buffer.from(i.data, 'base64') }));
    if (!images.length) throw new AppError(502, 'folax_failed', 'Folax returned no images');
    return images;
  }

  /**
   * Called (at most once per hour, see MediaService.reportDegraded) when a call shows Folax is down:
   * the adapter answered `auth_invalid` / `not_configured`.
   */
  onDown: ((err: AppError) => void) | null = null;
  private upstreamCache: { at: number; value: FolaxUpstream } | null = null;
  private usageCache: { at: number; value: FolaxUsage } | null = null;

  /**
   * One call to a v0.4+ endpoint (OpenAI-style errors). Throws AppError via `folaxError`; network failure → 503
   * `provider_unavailable`, our own timeout → 504 `folax_timeout`. `idempotencyKey` → `Idempotency-Key` header.
   */
  async api<T>(
    path: string,
    o: { method?: 'GET' | 'POST'; json?: unknown; idempotencyKey?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ body: T; status: number; headers: Headers }> {
    const res = await this.send(path, o);
    if (!res.ok) throw await this.failure(path, res);
    return { body: (await res.json()) as T, status: res.status, headers: res.headers };
  }

  /** Like `api` but hands back the raw Response on success (binary content, SSE streams). */
  async send(
    path: string,
    o: { method?: 'GET' | 'POST'; json?: unknown; idempotencyKey?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'X-API-Key': this.o.apiKey };
    if (o.json !== undefined) headers['Content-Type'] = 'application/json';
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    const timeout = AbortSignal.timeout(o.timeoutMs ?? this.o.timeoutMs ?? 150_000);
    try {
      return await this.fetch(`${this.base()}${path}`, {
        method: o.method ?? (o.json === undefined ? 'GET' : 'POST'),
        headers,
        ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      if (timeout.aborted) throw new AppError(504, 'folax_timeout', `Folax adapter did not answer within ${Math.round((o.timeoutMs ?? this.o.timeoutMs ?? 150_000) / 1000)} s`, { provider: 'folax' });
      this.upstreamCache = null;
      throw new AppError(503, 'provider_unavailable', `Folax adapter unreachable: ${(err as Error).message}`, { provider: 'folax', folax_code: 'unreachable' });
    }
  }

  /** Turns a non-2xx Response into an AppError; marks Folax down on `auth_invalid` / `not_configured`. */
  async failure(path: string, res: Response): Promise<AppError> {
    const body = await res.json().catch(() => null);
    const err = folaxError(res.status, body, res.headers.get('retry-after'));
    const folaxCode = String(err.details?.folax_code);
    this.o.log.warn('folax.failed', { path, status: res.status, code: folaxCode });
    if (DOWN_CODES.has(folaxCode)) {
      this.upstreamCache = {
        at: Date.now(),
        value: { status: 'down', checked_at: new Date().toISOString(), latency_ms: null, token: null, error: { code: folaxCode, message: err.message } },
      };
      this.onDown?.(err);
    }
    if (folaxCode === 'quota_exceeded') this.usageCache = null;
    return err;
  }

  /**
   * `POST /v1/images/edits`, synchronous (~5–25 s): `instruction` = free-prompt edit (weekly quota), `remove_people`
   * (no prompt, no quota). One image in, one out, no watermark. `idempotencyKey` makes a retry return the same result
   * without using quota again; a timeout on our side (504 without `folax_code`) is retried once with the same key.
   */
  async edit(o: { mode: FolaxEditMode; image: Buffer; prompt?: string; idempotencyKey: string; signal?: AbortSignal }): Promise<FolaxEditResult> {
    const json = { mode: o.mode, image: o.image.toString('base64'), ...(o.mode === 'instruction' ? { prompt: (o.prompt ?? '').trim().slice(0, FOLAX_PROMPT_MAX) } : {}) };
    // adapter: up to 30 s waiting for a slot + 120 s upstream
    const call = () => this.api<FolaxEditResponse>('/v1/images/edits', { json, idempotencyKey: o.idempotencyKey, timeoutMs: this.o.timeoutMs ?? 170_000, signal: o.signal });
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call();
    } catch (err) {
      const ours = err instanceof AppError && err.code === 'folax_timeout' && err.details?.folax_code === undefined;
      if (!ours) throw err;
      this.o.log.warn('folax.edit_retry', { key: o.idempotencyKey });
      r = await call();
    } finally {
      if (o.mode === 'instruction') this.invalidateUsage();
    }
    const img = r.body.images?.[0];
    if (!img?.data) throw new AppError(502, 'folax_failed', 'Folax returned no image', { provider: 'folax' });
    return {
      filename: img.file_name || `folax-edit.${(img.mime_type ?? 'image/jpeg').split('/')[1]}`,
      mimeType: img.mime_type ?? 'image/jpeg',
      bytes: Buffer.from(img.data, 'base64'),
      width: img.width ?? null,
      height: img.height ?? null,
      replayed: r.headers.get('idempotent-replayed') === 'true',
    };
  }

  /**
   * `POST /v1/videos` (image-to-video, async; ~7 s until 202). The weekly video quota is used when the task succeeds.
   * With `idempotencyKey` a repeat returns the same job (no new task), even after an adapter restart.
   */
  async submitVideo(o: { image: Buffer; prompt: string; idempotencyKey: string }): Promise<FolaxVideoJob> {
    const json = { image: o.image.toString('base64'), prompt: o.prompt.trim().slice(0, FOLAX_PROMPT_MAX) };
    return (await this.api<FolaxVideoJob>('/v1/videos', { json, idempotencyKey: o.idempotencyKey, timeoutMs: 120_000 })).body;
  }

  /** `GET /v1/videos/{id}`. 404 `folax_not_found` when the adapter forgot the job (restart without a key) → `resumeVideo`. */
  async videoStatus(id: string): Promise<FolaxVideoJob> {
    return (await this.api<FolaxVideoJob>(`/v1/videos/${encodeURIComponent(id)}`, { timeoutMs: 30_000 })).body;
  }

  /** `POST /v1/videos/resume`: a new adapter job for an existing upstream task (no quota). */
  async resumeVideo(taskId: string, clientTaskId: string | null): Promise<FolaxVideoJob> {
    return (await this.api<FolaxVideoJob>('/v1/videos/resume', { json: { task_id: taskId, client_task_id: clientTaskId }, timeoutMs: 60_000 })).body;
  }

  /** `GET /v1/videos/{id}/content`: the 720p mp4 (409 `folax_not_ready` before it succeeded). */
  async videoContent(id: string): Promise<Buffer> {
    const res = await this.send(`/v1/videos/${encodeURIComponent(id)}/content`, { timeoutMs: 180_000 });
    if (!res.ok) throw await this.failure('/v1/videos/content', res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** True only when the last known upstream state is `down` (no probe; cheap pre-check before creating a job). */
  knownDown(): boolean {
    const c = this.upstreamCache;
    return !!c && c.value.status === 'down' && Date.now() - c.at < this.cacheMs();
  }

  /** `GET /health/upstream` (a short Folax chat on the adapter side, no quota), cached for `statusCacheMs`. */
  async upstream(fresh = false): Promise<FolaxUpstream> {
    if (!fresh && this.upstreamCache && Date.now() - this.upstreamCache.at < this.cacheMs()) return this.upstreamCache.value;
    const started = Date.now();
    let value: FolaxUpstream;
    try {
      const res = await this.fetch(`${this.base()}/health/upstream${fresh ? '?fresh=1' : ''}`, {
        headers: { 'X-API-Key': this.o.apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      const b = (await res.json().catch(() => null)) as Partial<FolaxUpstream> | null;
      if (b && (b.status === 'ok' || b.status === 'degraded' || b.status === 'down')) {
        value = {
          status: b.status,
          checked_at: typeof b.checked_at === 'string' ? b.checked_at : new Date().toISOString(),
          latency_ms: typeof b.latency_ms === 'number' ? b.latency_ms : null,
          token: b.token ?? null,
          error: b.error ? { code: String(b.error.code), message: String(b.error.message ?? b.error.code) } : null,
        };
      } else {
        // 401 (our key) or an adapter older than 0.5.0 (404)
        const err = folaxError(res.status, b);
        value = { status: 'down', checked_at: new Date().toISOString(), latency_ms: null, token: null, error: { code: String(err.details?.folax_code), message: err.message } };
      }
    } catch (err) {
      value = {
        status: 'down',
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        token: null,
        error: { code: 'unreachable', message: `Folax adapter unreachable: ${(err as Error).message}` },
      };
    }
    if (value.status === 'down' && value.error && DOWN_CODES.has(value.error.code)) this.onDown?.(new AppError(503, 'provider_unavailable', value.error.message, { provider: 'folax', folax_code: value.error.code }));
    this.upstreamCache = { at: Date.now(), value };
    return value;
  }

  /** False only when the last upstream check said `down`. */
  async available(fresh = false): Promise<boolean> {
    return (await this.upstream(fresh)).status !== 'down';
  }

  /** `GET /v1/usage` (last quota the adapter saw; no quota used), cached for `statusCacheMs`. null when unreadable. */
  async usage(fresh = false): Promise<FolaxUsage | null> {
    if (!fresh && this.usageCache && Date.now() - this.usageCache.at < this.cacheMs()) return this.usageCache.value;
    try {
      const { body } = await this.api<FolaxUsage>('/v1/usage', { timeoutMs: 10_000 });
      if (!body?.video || !body?.edit) return null;
      this.usageCache = { at: Date.now(), value: { video: body.video, edit: body.edit } };
      return this.usageCache.value;
    } catch (err) {
      this.o.log.warn('folax.usage_failed', { err: (err as Error).message });
      return null;
    }
  }

  /** Forget the cached quota (after a video/edit used some). */
  invalidateUsage() {
    this.usageCache = null;
  }

  private cacheMs() {
    return this.o.statusCacheMs ?? 60_000;
  }

  private base() {
    return this.o.baseUrl.replace(/\/$/, '');
  }
}

/** Closest Folax ratio for a WxH size or a ratio string. */
export function toFolaxRatio(sizeOrRatio: string): FolaxRatio {
  const m = sizeOrRatio.match(/^(\d+)\s*[x:]\s*(\d+)$/);
  if (!m) return '1:1';
  const target = Math.log(Number(m[1]) / Number(m[2]));
  return FOLAX_RATIOS.reduce((best, r) => {
    const [a, b] = r.split(':').map(Number) as [number, number];
    const [c, d] = best.split(':').map(Number) as [number, number];
    return Math.abs(Math.log(a / b) - target) < Math.abs(Math.log(c / d) - target) ? r : best;
  }, '1:1' as FolaxRatio);
}
