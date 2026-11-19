import { AppError } from '../errors.js';
import type { Logger } from '../log.js';

export const UPSCALE_SCALES = [2, 4] as const;
export type UpscaleScale = (typeof UPSCALE_SCALES)[number];
export const UPSCALE_MODES = ['natural', 'sharp'] as const;
export type UpscaleMode = (typeof UPSCALE_MODES)[number];
/** Largest input the sidecar accepts (its UPSCALE_MAX_PIXELS default); checked before a job is created. */
export const UPSCALE_MAX_PIXELS = 4_200_000;

export type UpscaleBackend = 'gpu' | 'cpu';

export interface UpscaleResult {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** Which target produced it. */
  backend: UpscaleBackend;
  /** P1 (sharp), P4 (natural on CPU), P5 (natural on CUDA). */
  pipeline: string;
  device: string;
  faces: number;
  facesEnhanced: number;
  timingsMs: Record<string, number>;
}

export interface UpscaleTargetConfig {
  /** Base URL of a sidecar running `/v1/upscale`, e.g. http://10.121.21.101:8090 */
  baseUrl: string;
  /** Sent as `X-API-Key`; empty when the sidecar runs without auth. */
  apiKey?: string;
  /** Per call (queue wait not included). */
  timeoutMs: number;
}

export interface UpscaleOptions {
  /** Primary: the GPU box over ZeroTier. */
  gpu?: UpscaleTargetConfig;
  /** Fallback: the faceswap sidecar on CPU. */
  cpu?: UpscaleTargetConfig;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** How long a GPU readiness probe result is reused. Default 30 s. */
  readyCacheMs?: number;
}

/** Sidecar rejections caused by the image itself: the other backend would refuse it too, so no fallback. */
const IMAGE_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  TOO_LARGE: { status: 400, code: 'image_too_large', message: 'Image is too large to upscale (max 4.2 MP / 25 MB)' },
  BAD_IMAGE: { status: 400, code: 'bad_image', message: 'The image could not be read' },
  INVALID_REQUEST: { status: 400, code: 'upscale_failed', message: 'The upscaler rejected the request' },
};

/** A target failed in a way the other backend may not (down, overloaded, misconfigured): try the fallback. */
class TargetDown extends Error {}

/** One sidecar: a single call in flight (the upscalers use the whole CPU/GPU), the rest wait in FIFO order. */
class UpscaleTarget {
  private busy = false;
  private readonly waiting: (() => void)[] = [];
  private readyCache: { at: number; ready: boolean } | null = null;

  constructor(
    readonly name: UpscaleBackend,
    private readonly c: UpscaleTargetConfig,
    private readonly fetchFn: typeof fetch,
    private readonly log: Logger,
    private readonly readyCacheMs: number,
  ) {}

  /** `GET /health/ready` → `upscale.ready`, cached (pass `fresh` to probe now). */
  async ready(fresh = false): Promise<boolean> {
    if (!fresh && this.readyCache && Date.now() - this.readyCache.at < this.readyCacheMs) return this.readyCache.ready;
    let ready = false;
    try {
      const res = await this.fetchFn(`${this.base()}/health/ready`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as { upscale?: { ready?: unknown } };
      // /health/ready is 503 while face swap models load on the CPU box, but the upscaler may already be up
      ready = body.upscale?.ready === true;
    } catch {
      ready = false;
    }
    this.readyCache = { at: Date.now(), ready };
    return ready;
  }

  markDown() {
    this.readyCache = { at: Date.now(), ready: false };
  }

  async upscale(image: Buffer, o: { scale: UpscaleScale; mode: UpscaleMode }): Promise<UpscaleResult> {
    if (this.busy) await new Promise<void>((r) => this.waiting.push(r));
    else this.busy = true;
    try {
      return await this.request(image, o);
    } finally {
      // hand the slot straight to the next waiter, or free it
      const next = this.waiting.shift();
      if (next) next();
      else this.busy = false;
    }
  }

  private async request(image: Buffer, o: { scale: UpscaleScale; mode: UpscaleMode }): Promise<UpscaleResult> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base()}/v1/upscale`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: image.toString('base64'), scale: o.scale, mode: o.mode }),
        signal: AbortSignal.timeout(this.c.timeoutMs),
      });
    } catch (err) {
      throw new TargetDown(`${this.name} upscaler unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)))
        .catch(() => res.statusText);
      this.log.warn('upscale.failed', { backend: this.name, status: res.status, detail });
      const known = IMAGE_ERRORS[detail];
      if (known && (res.status === 413 || res.status === 422)) throw new AppError(known.status, known.code, known.message);
      // 5xx (models loading, UPSCALE_DISABLED), 401 (wrong key), 404 (sidecar without /v1/upscale): this backend is unusable
      throw new TargetDown(`${this.name} upscaler failed (${res.status} ${detail})`);
    }
    const r = (await res.json()) as {
      image: string;
      mime_type?: string;
      width: number;
      height: number;
      pipeline?: string;
      device?: string;
      faces?: number;
      faces_enhanced?: number;
      timings_ms?: Record<string, number>;
    };
    return {
      bytes: Buffer.from(r.image, 'base64'),
      mimeType: r.mime_type ?? 'image/jpeg',
      width: r.width,
      height: r.height,
      backend: this.name,
      pipeline: r.pipeline ?? '',
      device: r.device ?? '',
      faces: r.faces ?? 0,
      facesEnhanced: r.faces_enhanced ?? 0,
      timingsMs: r.timings_ms ?? {},
    };
  }

  private base() {
    return this.c.baseUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return this.c.apiKey ? { 'X-API-Key': this.c.apiKey } : {};
  }
}

/**
 * Image upscaling on the sidecar's `/v1/upscale`: the GPU box first, the CPU faceswap sidecar as fallback when the GPU
 * is not configured, not ready (cached probe), unreachable, times out or answers 5xx. Rejections of the image itself
 * (TOO_LARGE, BAD_IMAGE) end the call without fallback.
 */
export class UpscaleClient {
  private readonly gpu: UpscaleTarget | null;
  private readonly cpu: UpscaleTarget | null;
  private readonly log: Logger;

  constructor(o: UpscaleOptions) {
    const f = o.fetchImpl ?? fetch;
    const ttl = o.readyCacheMs ?? 30_000;
    this.gpu = o.gpu ? new UpscaleTarget('gpu', o.gpu, f, o.log, ttl) : null;
    this.cpu = o.cpu ? new UpscaleTarget('cpu', o.cpu, f, o.log, ttl) : null;
    this.log = o.log;
  }

  /** The GPU backend is configured and answered its (cached) readiness probe. */
  async gpuReady(fresh = false): Promise<boolean> {
    return !!this.gpu && (await this.gpu.ready(fresh));
  }

  async upscale(image: Buffer, o: { scale: UpscaleScale; mode: UpscaleMode }): Promise<UpscaleResult> {
    let down: string | null = null;
    // without a fallback the GPU gets its chance even when the cached probe said no
    if (this.gpu && (!this.cpu || (await this.gpu.ready()))) {
      try {
        return await this.gpu.upscale(image, o);
      } catch (err) {
        if (!(err instanceof TargetDown)) throw err;
        this.gpu.markDown();
        down = err.message;
        this.log.warn('upscale.gpu_fallback', { reason: err.message });
      }
    }
    if (!this.cpu) throw new AppError(503, 'upscale_unavailable', `The upscaler is unavailable (${down ?? 'not configured'})`);
    try {
      return await this.cpu.upscale(image, o);
    } catch (err) {
      if (err instanceof TargetDown) throw new AppError(503, 'upscale_unavailable', `The upscaler is unavailable (${err.message})`);
      throw err;
    }
  }
}
