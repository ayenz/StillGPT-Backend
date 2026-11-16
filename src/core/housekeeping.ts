import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { conversations, files } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Logger } from '../log.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderFile, QoderSession } from '../qoder/types.js';

/** Every agent this app creates is named `qr-<profile>` (see AgentPool); other agents on the account are left alone. */
const OUR_AGENT_PREFIX = 'qr-';
const MAX_PAGES = 200;

export interface HousekeepingReport {
  sessionsArchived: number;
  filesDeleted: number;
  filesInUse: number;
  bytesFreed: number;
  errors: number;
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
 */
export class QoderHousekeeper {
  private timer?: NodeJS.Timeout;
  private running?: Promise<HousekeepingReport>;

  constructor(
    private readonly d: {
      db: DB;
      qoder: QoderClient;
      log: Logger;
      retentionHours: number;
      intervalHours: number;
    },
  ) {}

  start() {
    if (this.d.intervalHours <= 0) return;
    // First pass shortly after boot (so restarts don't push it back a whole day), then on the interval.
    const first = setTimeout(() => void this.runSafe(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.runSafe(), this.d.intervalHours * 3600_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafe() {
    await this.run().catch((err) => this.d.log.error('housekeeping.failed', { err }));
  }

  /** One pass; concurrent calls share the pass already in flight. */
  run(now = new Date()): Promise<HousekeepingReport> {
    this.running ??= this.pass(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(now: Date): Promise<HousekeepingReport> {
    const cutoff = now.getTime() - this.d.retentionHours * 3600_000;
    const report: HousekeepingReport = { sessionsArchived: 0, filesDeleted: 0, filesInUse: 0, bytesFreed: 0, errors: 0 };

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
    for (const s of stale) {
      if (busy.has(s.id)) continue;
      try {
        // Detach first so a turn starting now creates a new session instead of using the archived one.
        await this.d.db
          .update(conversations)
          .set({ qoderSessionId: null, lastEventId: null })
          .where(and(eq(conversations.qoderSessionId, s.id), ne(conversations.status, 'busy')));
        await this.d.qoder.archiveSession(s.id);
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

    this.d.log.info('housekeeping.done', { ...report, retentionHours: this.d.retentionHours });
    return report;
  }

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
}

const isOurs = (s: QoderSession) => !!s.agent?.name?.startsWith(OUR_AGENT_PREFIX);
const isNotFound = (err: unknown) => err instanceof AppError && err.code === 'upstream_not_found';
const olderThan = (iso: string | undefined, cutoff: number) => !!iso && Date.parse(iso) < cutoff;
