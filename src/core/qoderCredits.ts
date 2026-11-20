import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { kv } from '../db/schema.js';
import type { Logger } from '../log.js';

const SESSION_KEY = 'qoder.web_session';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const USAGE_PATH = '/api/v2/me/usages/big_model_credits';
const HISTORY_PATH = '/api/v1/me/usages/big_model_credits/histories';
const ORG_USAGE_PATH = '/api/v1/me/organization-shared-usages/big_model_credits';
export const HISTORY_PAGE_SIZE_MAX = 100;

export interface QuotaSummary {
  used: number;
  limit: number;
  remaining: number;
  usagePercentage: number;
}

export interface QoderCredits extends QuotaSummary {
  unit: string;
  plan: QuotaSummary;
  resourcePackage: QuotaSummary;
  dedicatedResourcePackage: QuotaSummary;
  lastResetAt: string | null;
  nextResetAt: string | null;
  /** Organization add-on credits (shared pool); null when the account has none or they could not be read. */
  addOn: AddOnCredits | null;
}

export interface AddOnCredits {
  /** What this account used from the shared pool in the current cycle. */
  used: number;
  /** Per-member cap set by the organization; null = no cap. */
  cap: number | null;
  /** What this account can still use (pool remaining, or less when capped). */
  remaining: number;
  /** The organization's whole pool. */
  pool: QuotaSummary;
  /** Earliest expiry of the active add-on packages. */
  expiresAt: string | null;
}

export type CreditsState = 'ok' | 'not_configured' | 'session_expired' | 'error';

export interface QoderCreditsStatus {
  status: CreditsState;
  session: {
    configured: boolean;
    /** `admin` when set via the admin API, `env` when it comes from QODER_WEB_SESSION. */
    source: 'admin' | 'env' | null;
    /** When Qoder issued the cookie (read from the cookie itself), if it could be decoded. */
    issuedAt: string | null;
    updatedAt: string | null;
  };
  /** Last successful reading; kept (with stale = true) when a later fetch fails. */
  credits: QoderCredits | null;
  stale: boolean;
  /** When `credits` was fetched from Qoder. */
  fetchedAt: string | null;
  error: string | null;
}

export interface HistoryQuery {
  page: number;
  pageSize: number;
  start?: Date;
  end?: Date;
  order: 'asc' | 'desc';
}

export interface CreditHistoryItem {
  beginAt: string | null;
  finishAt: string | null;
  /** Qoder session id (`sess_…` for our cloud agents). */
  sessionId: string | null;
  businessId: string | null;
  /** Where it was used: "Cloud Agents" (this backend), "IDE", "Qoder", … */
  source: string;
  /** "Agent", "Video", "Image", … */
  operation: string;
  /** "Charged" / "Not Charged". */
  kind: string;
  model: string;
  credits: number;
  originalCredits: number;
  cost: number;
  originalCost: number;
  discountFactor: number;
}

export interface QoderCreditHistory {
  status: CreditsState;
  error: string | null;
  items: CreditHistoryItem[];
  /** Totals of this page only (Qoder does not return range totals). */
  pageSummary: { credits: number; originalCredits: number; cost: number; originalCost: number } | null;
  page: { current: number; pageSize: number; lastPage: number; totalItems: number } | null;
}

interface StoredSession {
  cookie: string;
  updatedAt: string;
}

/**
 * Remaining Qoder credits for the admin page. Qoder exposes them only on its web dashboard API
 * (qoder.com/api/v2/me/usages/…), which accepts the browser login cookie `qoder_session_cookie`
 * and rejects PAT / service-account tokens. The cookie comes from QODER_WEB_SESSION or is set by
 * an admin (stored in `kv`, takes precedence). Readings are cached for 5 minutes.
 */
export class QoderCreditsService {
  private cache?: { at: number; status: QoderCreditsStatus };
  private lastGood?: { credits: QoderCredits; fetchedAt: string };
  private inflight?: Promise<QoderCreditsStatus>;

  constructor(
    private readonly d: {
      db: DB;
      log: Logger;
      baseUrl: string;
      envSession?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async status(o: { refresh?: boolean } = {}): Promise<QoderCreditsStatus> {
    if (!o.refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.status;
    this.inflight ??= this.fetchStatus().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Set (or with null, clear back to the env value) the session cookie, then fetch with it. */
  async setSession(raw: string | null): Promise<QoderCreditsStatus> {
    if (raw === null) {
      await this.d.db.delete(kv).where(eq(kv.key, SESSION_KEY));
    } else {
      const value: StoredSession = { cookie: normalizeCookie(raw), updatedAt: new Date().toISOString() };
      await this.d.db.insert(kv).values({ key: SESSION_KEY, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    }
    this.d.log.info('qoder_credits.session_updated', { cleared: raw === null });
    this.cache = undefined;
    this.lastGood = undefined;
    return this.status({ refresh: true });
  }

  private async session(): Promise<{ cookie: string; source: 'admin' | 'env'; updatedAt: string | null } | null> {
    const [row] = await this.d.db.select().from(kv).where(eq(kv.key, SESSION_KEY));
    const stored = row?.value as StoredSession | undefined;
    if (stored?.cookie) return { cookie: stored.cookie, source: 'admin', updatedAt: stored.updatedAt };
    if (this.d.envSession) return { cookie: normalizeCookie(this.d.envSession), source: 'env', updatedAt: null };
    return null;
  }

  private async fetchStatus(): Promise<QoderCreditsStatus> {
    const s = await this.session();
    const base = {
      session: { configured: !!s, source: s?.source ?? null, issuedAt: s ? cookieIssuedAt(s.cookie) : null, updatedAt: s?.updatedAt ?? null },
    };
    const done = (status: QoderCreditsStatus) => {
      this.cache = { at: Date.now(), status };
      return status;
    };
    const failed = (state: CreditsState, error: string): QoderCreditsStatus =>
      done({ ...base, status: state, credits: this.lastGood?.credits ?? null, stale: !!this.lastGood, fetchedAt: this.lastGood?.fetchedAt ?? null, error });

    if (!s) return done({ ...base, status: 'not_configured', credits: null, stale: false, fetchedAt: null, error: null });

    const [r, org] = await Promise.all([this.get(s.cookie, USAGE_PATH), this.get(s.cookie, ORG_USAGE_PATH)]);
    if (!r.ok) return failed(r.state, r.error);
    let credits: QoderCredits;
    try {
      credits = parseUsage(r.body);
    } catch (err) {
      this.d.log.warn('qoder_credits.parse_failed', { err });
      return failed('error', 'Unexpected response from Qoder');
    }
    // Add-on credits are optional: accounts outside an organization have none.
    if (org.ok) {
      try {
        credits.addOn = parseAddOn(org.body);
      } catch (err) {
        this.d.log.warn('qoder_credits.parse_failed', { err, what: 'add_on' });
      }
    }
    this.lastGood = { credits, fetchedAt: new Date().toISOString() };
    return done({ ...base, status: 'ok', credits, stale: false, fetchedAt: this.lastGood.fetchedAt, error: null });
  }

  /** One page of Qoder's per-request credit history (not cached). */
  async history(q: HistoryQuery): Promise<QoderCreditHistory> {
    const s = await this.session();
    const empty = { items: [], pageSummary: null, page: null };
    if (!s) return { status: 'not_configured', error: null, ...empty };
    const params = new URLSearchParams({ page: String(q.page), page_size: String(q.pageSize), order_by: 'begin_at', order: q.order === 'asc' ? '1' : '-1' });
    if (q.start) params.set('start_time', String(q.start.getTime()));
    if (q.end) params.set('end_time', String(q.end.getTime()));
    const r = await this.get(s.cookie, `${HISTORY_PATH}?${params}`);
    if (!r.ok) return { status: r.state, error: r.error, ...empty };
    try {
      return { status: 'ok', error: null, ...parseHistory(r.body) };
    } catch (err) {
      this.d.log.warn('qoder_credits.parse_failed', { err, what: 'history' });
      return { status: 'error', error: 'Unexpected response from Qoder', ...empty };
    }
  }

  private async get(cookie: string, path: string): Promise<{ ok: true; body: unknown } | { ok: false; state: 'session_expired' | 'error'; error: string }> {
    let res: Response;
    try {
      res = await (this.d.fetchImpl ?? fetch)(this.d.baseUrl.replace(/\/$/, '') + path, {
        headers: { Cookie: `qoder_session_cookie=${cookie}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.d.log.warn('qoder_credits.fetch_failed', { err });
      return { ok: false, state: 'error', error: `Could not reach Qoder: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status === 401 || res.status === 403) {
      this.d.log.warn('qoder_credits.session_expired', { status: res.status });
      return { ok: false, state: 'session_expired', error: 'Qoder rejected the session cookie; set a new one' };
    }
    if (!res.ok) {
      this.d.log.warn('qoder_credits.fetch_failed', { status: res.status });
      return { ok: false, state: 'error', error: `Qoder returned HTTP ${res.status}` };
    }
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, state: 'error', error: 'Unexpected response from Qoder' };
    }
  }
}

/** Accept the bare value, `qoder_session_cookie=…`, or a whole Cookie header copied from the browser. */
export function normalizeCookie(raw: string): string {
  const v = raw.trim().replace(/^cookie:\s*/i, '');
  const m = /(?:^|;\s*)qoder_session_cookie=([^;]+)/.exec(v);
  return (m ? m[1]! : v).trim();
}

/** The cookie is `base64url(issuedUnixSeconds|data|mac)`; best effort. */
function cookieIssuedAt(cookie: string): string | null {
  try {
    const first = Buffer.from(cookie, 'base64url').toString('latin1').split('|')[0] ?? '';
    const sec = Number(first);
    return /^\d{9,11}$/.test(first) && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

function parseUsage(body: unknown): QoderCredits {
  const b = body as Record<string, any>;
  const total = b?.total_quota?.quota_summary;
  if (!total || typeof total.remaining_value !== 'number') throw new Error('missing total_quota.quota_summary');
  const sum = (q: any): QuotaSummary => ({
    used: num(q?.used_value),
    limit: num(q?.limit_value),
    remaining: num(q?.remaining_value),
    usagePercentage: num(q?.usage_percentage),
  });
  const ms = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);
  return {
    ...sum(total),
    unit: typeof total.unit === 'string' ? total.unit : 'credits',
    plan: sum(b.plan_quota?.quota_summary),
    resourcePackage: sum(b.resource_package_quota?.quota_summary),
    dedicatedResourcePackage: sum(b.dedicated_resource_package_quota?.quota_summary),
    lastResetAt: ms(b.lastResetAt),
    nextResetAt: ms(b.nextResetAt),
    addOn: null,
  };
}

function parseAddOn(body: unknown): AddOnCredits | null {
  const b = body as Record<string, any>;
  const mine = b?.shared_quota?.quota_summary;
  const pool = b?.organization_pool;
  if (!mine && !pool) return null;
  if (typeof mine?.used_value !== 'number' && typeof pool?.limit_value !== 'number') throw new Error('missing shared_quota / organization_pool');
  const poolSum: QuotaSummary = {
    used: num(pool?.used_value),
    limit: num(pool?.limit_value),
    remaining: num(pool?.remaining_value),
    usagePercentage: num(pool?.usage_percentage),
  };
  if (poolSum.limit <= 0 && num(mine?.used_value) === 0) return null;
  const cap = typeof mine?.limit_value === 'number' && mine.limit_value >= 0 ? mine.limit_value : null;
  const expiries = (Array.isArray(b.shared_quota?.quota_detail) ? b.shared_quota.quota_detail : [])
    .filter((d: any) => d?.is_active !== false && typeof d?.expires_at === 'number' && d.expires_at > 0)
    .map((d: any) => d.expires_at as number);
  return {
    used: num(mine?.used_value),
    cap,
    remaining: typeof mine?.remaining_value === 'number' ? mine.remaining_value : poolSum.remaining,
    pool: poolSum,
    expiresAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseHistory(body: unknown): Pick<QoderCreditHistory, 'items' | 'pageSummary' | 'page'> {
  const b = body as Record<string, any>;
  if (!b || !Array.isArray(b.data)) throw new Error('missing data[]');
  const ms = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const p = b.page_result ?? {};
  return {
    items: b.data.map((r: any) => ({
      beginAt: ms(r.begin_at ?? r.time),
      finishAt: ms(r.finish_at),
      sessionId: str(r.session_id),
      businessId: str(r.business_id),
      source: String(r.source ?? ''),
      operation: String(r.operation ?? ''),
      kind: String(r.kind ?? ''),
      model: String(r.model_category ?? ''),
      credits: num(r.credits),
      originalCredits: num(r.original_credits),
      cost: num(r.cost),
      originalCost: num(r.original_cost),
      discountFactor: num(r.discount_factor),
    })),
    pageSummary: b.summary
      ? { credits: num(b.summary.credits), originalCredits: num(b.summary.original_credits), cost: num(b.summary.cost), originalCost: num(b.summary.original_cost) }
      : null,
    page: { current: num(p.current_page), pageSize: num(p.page_size), lastPage: num(p.last_page), totalItems: num(p.total_size) },
  };
}
