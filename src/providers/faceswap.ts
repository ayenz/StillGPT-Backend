import { AppError } from '../errors.js';
import type { Logger } from '../log.js';

/** Options of the inswapper engine (`POST /v1/swap` `options`). */
export interface SwapperOptions {
  target_faces: 'largest' | 'all';
  identity_mode: 'average' | 'frontal';
  det_thresh: number;
  restorer: 'codeformer' | 'gfpgan' | 'off';
  restore_blend: number;
  codeformer_fidelity: number;
}

export interface FaceSwapImage {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface SwapResult extends FaceSwapImage {
  targetFaces: number;
  sourceFaces: number;
  timingsMs: Record<string, number>;
}

/** Square around the target's largest face: `[x, y, side, side]` in original (EXIF-corrected) pixels. */
export type FaceBox = [number, number, number, number];

export interface CropResult {
  /** PNG, size×size. */
  crop: Buffer;
  box: FaceBox;
  faces: number;
}

export interface FaceSwapReadiness {
  ready: boolean;
  models?: Record<string, unknown>;
  version?: string;
}

export interface FaceSwapOptions {
  /** Base URL of the faceswap sidecar, e.g. http://faceswap:8080 */
  baseUrl: string;
  /** Sent as `X-API-Key`; empty when the sidecar runs without auth. */
  apiKey?: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Per call. CPU inference of a big photo with restoration takes a while. Default 120 s. */
  timeoutMs?: number;
  /** Calls in flight at once; later calls wait in FIFO order. Default 2 (CPU bound). */
  concurrency?: number;
  /** How long a readiness probe result is reused. Default 30 s. */
  readyCacheMs?: number;
}

/** Sidecar `{detail}` codes → our job/API error codes. */
const CODES: Record<string, { status: number; code: string; message: string }> = {
  NO_FACE_IN_TARGET: { status: 400, code: 'no_face_in_target', message: 'No face found in the target image' },
  NO_FACE_IN_SOURCE: { status: 400, code: 'no_face_in_source', message: 'No face found in the face image' },
  BAD_IMAGE: { status: 400, code: 'faceswap_failed', message: 'Face swap could not read an image' },
  TOO_LARGE: { status: 400, code: 'faceswap_failed', message: 'Image is too large for face swap (max 25 MB / 40 MP)' },
  AUTH_INVALID: { status: 503, code: 'faceswap_unavailable', message: 'Face swap service rejected the API key' },
};

/**
 * Client for the faceswap sidecar (Python: InsightFace + inswapper + face restore, CPU). Images travel as base64 JSON.
 * Calls are CPU bound, so only `concurrency` run at once; the rest wait in FIFO order.
 */
export class FaceSwapClient {
  private readonly fetch: typeof fetch;
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readyCache: { at: number; value: FaceSwapReadiness } | null = null;

  constructor(private readonly o: FaceSwapOptions) {
    this.fetch = o.fetchImpl ?? fetch;
    this.limit = Math.max(1, o.concurrency ?? 2);
  }

  async swap(target: Buffer, sources: Buffer[], options: Partial<SwapperOptions> = {}): Promise<SwapResult> {
    const r = await this.call<{ image: string; mime_type: string; width: number; height: number; target_faces: number; source_faces: number; timings_ms?: Record<string, number> }>(
      '/v1/swap',
      { target: b64(target), sources: sources.map(b64), options },
    );
    return {
      bytes: Buffer.from(r.image, 'base64'),
      mimeType: r.mime_type,
      width: r.width,
      height: r.height,
      targetFaces: r.target_faces,
      sourceFaces: r.source_faces,
      timingsMs: r.timings_ms ?? {},
    };
  }

  async crop(image: Buffer, o: { detThresh?: number; expand?: number; size?: number } = {}): Promise<CropResult> {
    const r = await this.call<{ crop: string; box: number[]; faces: number }>('/v1/face-crop', {
      image: b64(image),
      ...(o.detThresh !== undefined ? { det_thresh: o.detThresh } : {}),
      ...(o.expand !== undefined ? { expand: o.expand } : {}),
      ...(o.size !== undefined ? { size: o.size } : {}),
    });
    if (!Array.isArray(r.box) || r.box.length !== 4) throw new AppError(502, 'faceswap_failed', 'Face swap returned no crop box');
    return { crop: Buffer.from(r.crop, 'base64'), box: r.box.map(Number) as FaceBox, faces: r.faces };
  }

  async paste(base: Buffer, patch: Buffer, box: FaceBox): Promise<FaceSwapImage> {
    const r = await this.call<{ image: string; mime_type: string; width: number; height: number }>('/v1/face-paste', { base: b64(base), patch: b64(patch), box });
    return { bytes: Buffer.from(r.image, 'base64'), mimeType: r.mime_type, width: r.width, height: r.height };
  }

  /** `GET /health/ready`, cached for `readyCacheMs` (pass `fresh` to probe now). */
  async readiness(fresh = false): Promise<FaceSwapReadiness> {
    const ttl = this.o.readyCacheMs ?? 30_000;
    if (!fresh && this.readyCache && Date.now() - this.readyCache.at < ttl) return this.readyCache.value;
    let value: FaceSwapReadiness;
    try {
      const res = await this.fetch(`${this.base()}/health/ready`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as { ready?: unknown; models?: Record<string, unknown>; version?: unknown };
      value = { ready: res.ok && body.ready !== false, ...(body.models ? { models: body.models } : {}), ...(typeof body.version === 'string' ? { version: body.version } : {}) };
    } catch {
      value = { ready: false };
    }
    this.readyCache = { at: Date.now(), value };
    return value;
  }

  async ready(fresh = false): Promise<boolean> {
    return (await this.readiness(fresh)).ready;
  }

  private async call<T>(path: string, payload: unknown): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await this.request<T>(path, payload);
    } finally {
      // hand the slot straight to the next waiter (active stays the same), or free it
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async request<T>(path: string, payload: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      });
    } catch (err) {
      this.readyCache = null;
      throw new AppError(503, 'faceswap_unavailable', `Face swap service unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)))
        .catch(() => res.statusText);
      this.o.log.warn('faceswap.failed', { path, status: res.status, detail });
      const known = CODES[detail];
      if (known) throw new AppError(known.status, known.code, known.message);
      if (res.status === 503) throw new AppError(503, 'faceswap_unavailable', `Face swap service is not ready (${detail})`);
      throw new AppError(502, 'faceswap_failed', `Face swap failed: ${detail}`);
    }
    return (await res.json()) as T;
  }

  private base() {
    return this.o.baseUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return this.o.apiKey ? { 'X-API-Key': this.o.apiKey } : {};
  }
}

const b64 = (b: Buffer) => b.toString('base64');
