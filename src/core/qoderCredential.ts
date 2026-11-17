import { count, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { conversations, kv, mediaJobs } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { sha256 } from '../ids.js';
import type { Logger } from '../log.js';
import type { TokenProvider } from '../qoder/tokens.js';

const PAT_KEY = 'qoder.pat';

interface StoredPat {
  pat: string;
  updatedAt: string;
}

export interface QoderCredentialStatus {
  /** Which credential authenticates Qoder calls right now. */
  mode: 'service_account' | 'pat' | 'none';
  /** Where the PAT comes from (`admin` = set via the admin API, `env` = QODER_PAT). */
  source: 'admin' | 'env' | null;
  /** Last 4 characters of the active PAT; the token itself is never returned. */
  last4: string | null;
  /** When an admin last set the PAT (null for env). */
  updatedAt: string | null;
  /** True when QODER_ENVIRONMENT_ID pins an environment, which may not exist on another account. */
  environmentPinned: boolean;
}

export interface SetPatResult {
  status: QoderCredentialStatus;
  /** The credential now points at a different account/token than before: cached agents were reset. */
  accountChanged: boolean;
}

/**
 * The Qoder credential, used as the QoderClient's TokenProvider. QODER_SA_KEY wins when set;
 * otherwise a PAT set by an admin (stored in `kv`) overrides QODER_PAT. Changing it takes effect on
 * the next request; `onChange` resets account-bound caches (environment, agents, models).
 */
export class QoderCredentialService implements TokenProvider {
  private stored?: StoredPat;
  /** Called after the active credential changed, with the new fingerprint (null = none configured). */
  onChange?: (fingerprint: string | null) => Promise<void>;

  constructor(
    private readonly d: {
      db: DB;
      log: Logger;
      baseUrl: string;
      envPat?: string;
      saKey?: string;
      saProvider?: TokenProvider;
      environmentPinned: boolean;
      /** Throws when `pat` cannot list environments (wrong/revoked token). */
      probe: (pat: string) => Promise<void>;
    },
  ) {}

  /** Read the admin-set PAT. Call once before the first Qoder request. */
  async load(): Promise<void> {
    const [row] = await this.d.db.select().from(kv).where(eq(kv.key, PAT_KEY));
    this.stored = (row?.value as StoredPat | undefined) ?? undefined;
  }

  private activePat(): string | undefined {
    return this.stored?.pat ?? this.d.envPat;
  }

  async getToken(): Promise<string> {
    if (this.d.saProvider) return this.d.saProvider.getToken();
    const pat = this.activePat();
    if (!pat) throw new AppError(503, 'qoder_not_configured', 'No Qoder credential configured: an admin must set a PAT (PUT /admin/qoder/credential)');
    return pat;
  }

  /** Identifies the account the credential points at (null when none is configured). */
  fingerprint(): string | null {
    const secret = this.d.saKey ?? this.activePat();
    return secret ? sha256(`${this.d.baseUrl}\n${secret}`) : null;
  }

  status(): QoderCredentialStatus {
    const pat = this.activePat();
    if (this.d.saKey) return { mode: 'service_account', source: 'env', last4: null, updatedAt: null, environmentPinned: this.d.environmentPinned };
    return {
      mode: pat ? 'pat' : 'none',
      source: this.stored ? 'admin' : pat ? 'env' : null,
      last4: pat ? pat.slice(-4) : null,
      updatedAt: this.stored?.updatedAt ?? null,
      environmentPinned: this.d.environmentPinned,
    };
  }

  /** Work that would break mid-flight if the account changed. */
  async busy(): Promise<{ conversations: number; mediaJobs: number }> {
    const [c] = await this.d.db.select({ n: count() }).from(conversations).where(eq(conversations.status, 'busy'));
    const [m] = await this.d.db.select({ n: count() }).from(mediaJobs).where(eq(mediaJobs.status, 'in_progress'));
    return { conversations: Number(c?.n ?? 0), mediaJobs: Number(m?.n ?? 0) };
  }

  /**
   * Set the PAT (or with null, clear back to QODER_PAT). A new PAT is checked against Qoder first and
   * saved only if it works. Refuses while turns/media jobs are running unless `force`.
   */
  async setPat(pat: string | null, o: { force?: boolean } = {}): Promise<SetPatResult> {
    if (this.d.saKey) throw conflict('QODER_SA_KEY is set and takes precedence over a PAT; remove it from the environment first', 'service_account_active');
    if (pat === null && !this.stored) return { status: this.status(), accountChanged: false };
    if (pat === null && !this.d.envPat) throw conflict('QODER_PAT is not set, so clearing the admin PAT would leave Qoder unconfigured', 'qoder_pat_required');

    if (!o.force) {
      const busy = await this.busy();
      if (busy.conversations || busy.mediaJobs) {
        throw new AppError(
          409,
          'qoder_busy',
          `${busy.conversations} conversation(s) and ${busy.mediaJobs} media job(s) are running on the current credential; retry later or pass force: true`,
          { busy_conversations: busy.conversations, busy_media_jobs: busy.mediaJobs },
        );
      }
    }

    const next = pat ?? this.d.envPat!;
    try {
      await this.d.probe(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const unauthorized = err instanceof AppError && err.code === 'upstream_auth';
      if (unauthorized || (err instanceof AppError && err.status < 500)) throw badRequest(`Qoder rejected this PAT: ${msg}`, 'invalid_qoder_pat');
      throw new AppError(502, 'upstream_unavailable', `Could not verify the PAT with Qoder: ${msg}`);
    }

    const before = this.fingerprint();
    if (pat === null) {
      await this.d.db.delete(kv).where(eq(kv.key, PAT_KEY));
      this.stored = undefined;
    } else {
      const value: StoredPat = { pat, updatedAt: new Date().toISOString() };
      await this.d.db.insert(kv).values({ key: PAT_KEY, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      this.stored = value;
    }
    const after = this.fingerprint();
    const accountChanged = before !== after;
    this.d.log.info('qoder.credential_updated', { source: this.status().source, last4: this.status().last4, accountChanged });
    if (accountChanged) await this.onChange?.(after);
    return { status: this.status(), accountChanged };
  }
}
