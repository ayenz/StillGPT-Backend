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

  async ready(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.o.baseUrl.replace(/\/$/, '')}/health/ready`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
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
