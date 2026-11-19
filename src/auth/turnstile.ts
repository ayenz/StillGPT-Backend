import { AppError } from '../errors.js';
import type { Logger } from '../log.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 10_000;

export interface TurnstileConfig {
  secret: string;
  /** Hostnames the widget may be solved on (the frontend's), e.g. `stillgpt.example.com`. */
  hostnames: string[];
}

/** TURNSTILE_* from config; hostnames default to the hosts of CORS_ORIGINS (without "*"). null = Turnstile off. */
export function turnstileConfig(c: { TURNSTILE_SECRET_KEY?: string; TURNSTILE_HOSTNAMES?: string[]; CORS_ORIGINS: string[] }): TurnstileConfig | null {
  if (!c.TURNSTILE_SECRET_KEY) return null;
  const hostnames =
    c.TURNSTILE_HOSTNAMES ??
    c.CORS_ORIGINS.filter((o) => o !== '*').flatMap((o) => {
      try {
        return [new URL(o).hostname];
      } catch {
        return [];
      }
    });
  return { secret: c.TURNSTILE_SECRET_KEY, hostnames: hostnames.map((h) => h.toLowerCase()) };
}

const rejected = (message = 'Human verification failed. Please try again.') => new AppError(403, 'turnstile_failed', message);

interface SiteverifyResult {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
}

/**
 * Cloudflare Turnstile server-side check (browser → this backend → siteverify). Fails closed: a missing token,
 * a network error/timeout, a non-OK status, a wrong action or a hostname outside the allowlist are all a 403.
 */
export class TurnstileVerifier {
  constructor(
    private readonly cfg: TurnstileConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string | undefined, opts: { action: string; remoteIp?: string }): Promise<void> {
    if (!token) throw rejected('Complete the human verification first.');
    if (token.length > 2048) throw rejected();
    const form = new URLSearchParams({ secret: this.cfg.secret, response: token });
    if (opts.remoteIp) form.set('remoteip', opts.remoteIp);

    let result: SiteverifyResult;
    try {
      const res = await this.fetchImpl(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        this.log.warn('turnstile.http_error', { status: res.status });
        throw rejected();
      }
      result = (await res.json()) as SiteverifyResult;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.log.warn('turnstile.unreachable', { err: err instanceof Error ? err.message : String(err) });
      throw rejected();
    }

    if (result.success !== true) {
      this.log.info('turnstile.rejected', { codes: result['error-codes'] });
      throw rejected();
    }
    if (result.action !== opts.action) {
      this.log.warn('turnstile.wrong_action', { action: result.action, expected: opts.action });
      throw rejected();
    }
    if (!result.hostname || !this.cfg.hostnames.includes(result.hostname.toLowerCase())) {
      this.log.warn('turnstile.wrong_hostname', { hostname: result.hostname });
      throw rejected();
    }
  }
}
