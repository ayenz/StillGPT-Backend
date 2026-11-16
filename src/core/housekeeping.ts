import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { conversations, files, kv } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Logger } from '../log.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderFile, QoderSession } from '../qoder/types.js';

/** Every agent this app creates is named `qr-<profile>` (see AgentPool); other agents on the account are left alone. */
const OUR_AGENT_PREFIX = 'qr-';
const MAX_PAGES = 200;
/** How often the scheduler checks whether a pass is due. */
const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 60_000;
const SETTINGS_KEY = 'housekeeping.settings';
const LAST_RUN_KEY = 'housekeeping.last_run';

export const RETENTION_HOURS_MAX = 24 * 365;
export const INTERVAL_HOURS_MAX = 24 * 30;

export interface HousekeepingSettings {
  enabled: boolean;
  /** Sessions idle longer than this are archived; our Qoder files older than this are deleted. */
  retentionHours: number;
  /** Minimum time between automatic passes. */
  intervalHours: number;
}

export interface HousekeepingReport {
  dryRun: boolean;
  sessionsArchived: number;
  filesDeleted: number;
  filesInUse: number;
  bytesFreed: number;
  errors: number;
}

export interface HousekeepingRun {
  at: string;
  trigger: 'schedule' | 'manual';
  retentionHours: number;
  report?: HousekeepingReport;
  error?: string;
}

export interface HousekeepingStatus {
  settings: HousekeepingSettings;
  /** `admin` once an admin saved settings; before that the env defaults apply. */
  source: 'env' | 'admin';
  lastRun: HousekeepingRun | null;
  /** When the scheduler will run next (null when disabled). It checks every 10 minutes. */
  nextRunAt: string | null;
  running: boolean;
}

/**
 * Clears what accumulates upstream on Qoder: every artifact we receive is already copied into our
 * media store, and every upload we keep locally, so the Qoder copies are only needed while a session
 * still uses them.
 *
 * 1. Archive our sessions that have been idle longer than the retention window. Their conversations
 *    lose the session id, so the next message starts a fresh session with the history preamble.
 * 2. Delete our Qoder files older than the window. Qoder refuses (409) while a live session mounts a
 *    file, so anything still in use is skipped. Local rows forget the Qoder id and re-upload on demand.
 *
 * Settings live in `kv` (editable by admins); env values are the defaults until an admin saves.
 */
export class QoderHousekeeper {
  private timers: NodeJS.Timeout[] = [];
  private running?: Promise<HousekeepingReport>;

  constructor(
    private readonly d: {
      db: DB;
      qoder: QoderClient;
      log: Logger;
      /** Env defaults. */
      defaults: HousekeepingSettings;
    },
  ) {}

  start() {
    const first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => void this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ── settings ──────────────────────────────────────────────────────────────

  async status(): Promise<HousekeepingStatus> {
    const [stored, lastRun] = await Promise.all([this.read<HousekeepingSettings>(SETTINGS_KEY), this.read<HousekeepingRun>(LAST_RUN_KEY)]);
    const settings = stored ?? this.d.defaults;
    return {
      settings,
      source: stored ? 'admin' : 'env',
      lastRun,
      nextRunAt: settings.enabled ? new Date(lastRun ? Math.max(Date.parse(lastRun.at) + settings.intervalHours * 3600_000, Date.now()) : Date.now()).toISOString() : null,
      running: !!this.running,
    };
  }

  async settings(): Promise<HousekeepingSettings> {
    return (await this.read<HousekeepingSettings>(SETTINGS_KEY)) ?? this.d.defaults;
  }

  async updateSettings(patch: Partial<HousekeepingSettings>): Promise<HousekeepingStatus> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: HousekeepingSettings = { ...(await this.settings()), ...defined };
    await this.write(SETTINGS_KEY, next);
    this.d.log.info('housekeeping.settings_updated', { ...next });
    return this.status();
  }

  // ── running ───────────────────────────────────────────────────────────────

  /** Scheduler: run when enabled and the interval has passed since the last real pass. */
  async tick(now = new Date()) {
    try {
      const settings = await this.settings();
      if (!settings.enabled) return;
      const last = await this.read<HousekeepingRun>(LAST_RUN_KEY);
      if (last && now.getTime() - Date.parse(last.at) < settings.intervalHours * 3600_000) return;
      await this.run({ now, trigger: 'schedule' });
    } catch (err) {
      this.d.log.error('housekeeping.failed', { err });
    }
  }

  /**
   * One pass with the saved retention (or `retentionHours`). A dry run changes nothing and reports
   * what a real pass would do (files still mounted by live sessions are counted as in use).
   * Concurrent real passes share the one in flight.
   */
  async run(o: { now?: Date; dryRun?: boolean; retentionHours?: number; trigger?: HousekeepingRun['trigger'] } = {}): Promise<HousekeepingReport> {
    const now = o.now ?? new Date();
    const retentionHours = o.retentionHours ?? (await this.settings()).retentionHours;
    if (o.dryRun) return this.pass(now, retentionHours, true);
    this.running ??= this.recorded(now, retentionHours, o.trigger ?? 'manual').finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async recorded(now: Date, retentionHours: number, trigger: HousekeepingRun['trigger']) {
    const run: HousekeepingRun = { at: now.toISOString(), trigger, retentionHours };
    try {
      run.report = await this.pass(now, retentionHours, false);
      return run.report;
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.write(LAST_RUN_KEY, run).catch(() => {});
    }
  }

  private async pass(now: Date, retentionHours: number, dryRun: boolean): Promise<HousekeepingReport> {
    const cutoff = now.getTime() - retentionHours * 3600_000;
    const report: HousekeepingReport = { dryRun, sessionsArchived: 0, filesDeleted: 0, filesInUse: 0, bytesFreed: 0, errors: 0 };

    // ── sessions ──
    const sessions = await this.collect((afterId) => this.d.qoder.listSessions({ afterId }));
    const ours = new Map(sessions.filter(isOurs).map((s) => [s.id, s]));
    const stale = [...ours.values()].filter((s) => !s.archived_at && s.status === 'idle' && olderThan(s.updated_at ?? s.created_at, cutoff));
    const busy = new Set(
      stale.length
        ? (
            await this.d.db
              .select({ sid: conversations.qoderSessionId })
              .from(conversations)
              .where(and(inArray(conversations.qoderSessionId, stale.map((s) => s.id)), eq(conversations.status, 'busy')))
          ).map((r) => r.sid)
        : [],
    );
    const archived = new Set<string>();
    for (const s of stale) {
      if (busy.has(s.id)) continue;
      if (dryRun) {
        archived.add(s.id);
        report.sessionsArchived++;
        continue;
      }
      try {
        // Detach first so a turn starting now creates a new session instead of using the archived one.
        await this.d.db
          .update(conversations)
          .set({ qoderSessionId: null, lastEventId: null })
          .where(and(eq(conversations.qoderSessionId, s.id), ne(conversations.status, 'busy')));
        await this.d.qoder.archiveSession(s.id);
        archived.add(s.id);
        report.sessionsArchived++;
      } catch (err) {
        if (isNotFound(err)) continue;
        report.errors++;
        this.d.log.warn('housekeeping.archive_failed', { sessionId: s.id, err });
      }
    }

    // ── files ──
    const qfiles = await this.collect((afterId) => this.d.qoder.listFiles({ afterId }));
    const candidates = qfiles.filter((f) => olderThan(f.created_at, cutoff));
    const known = await this.knownUploads(candidates.filter((f) => !f.scope).map((f) => f.id));
    for (const f of candidates) {
      if (!(f.scope ? f.scope.type === 'session' && ours.has(f.scope.id) : known.has(f.id))) continue;
      if (dryRun) {
        // Session files are freed once their session is (or was already) archived.
        const live = f.scope && !ours.get(f.scope.id)?.archived_at && !archived.has(f.scope.id);
        if (live) report.filesInUse++;
        else {
          report.filesDeleted++;
          report.bytesFreed += f.size_bytes;
        }
        continue;
      }
      try {
        await this.d.qoder.deleteFile(f.id);
        report.filesDeleted++;
        report.bytesFreed += f.size_bytes;
      } catch (err) {
        if (err instanceof AppError && err.code === 'upstream_conflict') {
          report.filesInUse++;
          continue;
        }
        if (!isNotFound(err)) {
          report.errors++;
          this.d.log.warn('housekeeping.delete_failed', { fileId: f.id, err });
          continue;
        }
      }
      await this.d.db.update(files).set({ qoderFileId: null }).where(eq(files.qoderFileId, f.id));
    }

    this.d.log.info('housekeeping.done', { ...report, retentionHours });
    return report;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async knownUploads(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.d.db.select({ q: files.qoderFileId }).from(files).where(inArray(files.qoderFileId, ids));
    return new Set(rows.map((r) => r.q!));
  }

  private async collect<T extends QoderSession | QoderFile>(page: (afterId?: string) => Promise<{ data: T[]; has_more: boolean; last_id?: string | null }>) {
    const out: T[] = [];
    let afterId: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await page(afterId);
      out.push(...res.data);
      if (!res.has_more || !res.last_id) break;
      afterId = res.last_id;
    }
    return out;
  }

  private async read<T>(key: string): Promise<T | null> {
    const [row] = await this.d.db.select().from(kv).where(eq(kv.key, key));
    return (row?.value as T | undefined) ?? null;
  }

  private async write(key: string, value: unknown) {
    await this.d.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  }
}

const isOurs = (s: QoderSession) => !!s.agent?.name?.startsWith(OUR_AGENT_PREFIX);
const isNotFound = (err: unknown) => err instanceof AppError && err.code === 'upstream_not_found';
const olderThan = (iso: string | undefined, cutoff: number) => !!iso && Date.parse(iso) < cutoff;
