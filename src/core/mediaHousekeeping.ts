import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { conversations, files, kv, mediaJobs, messages } from '../db/schema.js';
import type { Logger } from '../log.js';
import { emptyCounts, type MediaTrash, type PurgeCounts } from './trash.js';

const SETTINGS_KEY = 'media_housekeeping.settings';
const LAST_RUN_KEY = 'media_housekeeping.last_run';
const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 2 * 60_000;
/** Most rows one step handles per pass, so a large backlog is worked off over several passes. */
const BATCH = 2000;
const DAY_MS = 86400_000;

export const DAYS_MAX = 3650;
export const GRACE_DAYS_MAX = 365;
export const MEDIA_INTERVAL_HOURS_MAX = 24 * 30;

export interface MediaHousekeepingSettings {
  enabled: boolean;
  /** Days a job stays in the trash before it is deleted for good (0 = at the next pass). */
  trashGraceDays: number;
  /** Failed jobs older than this go to the trash (0 = never). */
  hideFailedAfterDays: number;
  /** Media of chats archived longer than this is deleted (0 = never). */
  archivedChatMediaDays: number;
  /** Uploads nothing has used for this long are deleted (0 = never). */
  unusedUploadDays: number;
  /** Finished jobs older than this go to the trash (0 = keep forever). */
  retentionDays: number;
  intervalHours: number;
}

export const MEDIA_HOUSEKEEPING_DEFAULTS: MediaHousekeepingSettings = {
  enabled: true,
  trashGraceDays: 7,
  hideFailedAfterDays: 7,
  archivedChatMediaDays: 30,
  unusedUploadDays: 30,
  retentionDays: 0,
  intervalHours: 24,
};

export interface MediaHousekeepingReport extends PurgeCounts {
  dryRun: boolean;
  /** Jobs moved to the trash by this pass (old failed jobs, retention). */
  jobsTrashed: number;
}

export interface MediaHousekeepingRun {
  at: string;
  trigger: 'schedule' | 'manual';
  report?: MediaHousekeepingReport;
  error?: string;
}

export interface MediaHousekeepingStatus {
  settings: MediaHousekeepingSettings;
  source: 'default' | 'admin';
  lastRun: MediaHousekeepingRun | null;
  nextRunAt: string | null;
  running: boolean;
}

/**
 * Local media housekeeping (the gallery side; QoderHousekeeper cleans upstream). Each pass:
 * 1. trashes failed jobs older than `hideFailedAfterDays` and, if set, finished jobs older than `retentionDays`;
 * 2. deletes jobs whose trash grace period is over (outputs only when nothing live still uses them);
 * 3. deletes the media of chats archived longer than `archivedChatMediaDays`;
 * 4. deletes uploads unused for `unusedUploadDays`;
 * 5. sweeps hidden files left over from earlier passes once nothing uses them.
 * Settings live in `kv` (admin API); built-in defaults apply until an admin saves.
 */
export class MediaHousekeeper {
  private timers: NodeJS.Timeout[] = [];
  private running?: Promise<MediaHousekeepingReport>;

  constructor(private readonly d: { db: DB; trash: MediaTrash; log: Logger }) {}

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

  async status(): Promise<MediaHousekeepingStatus> {
    const [stored, lastRun] = await Promise.all([this.read<Partial<MediaHousekeepingSettings>>(SETTINGS_KEY), this.read<MediaHousekeepingRun>(LAST_RUN_KEY)]);
    const settings = { ...MEDIA_HOUSEKEEPING_DEFAULTS, ...stored };
    return {
      settings,
      source: stored ? 'admin' : 'default',
      lastRun,
      nextRunAt: settings.enabled ? new Date(lastRun ? Math.max(Date.parse(lastRun.at) + settings.intervalHours * 3600_000, Date.now()) : Date.now()).toISOString() : null,
      running: !!this.running,
    };
  }

  async settings(): Promise<MediaHousekeepingSettings> {
    return { ...MEDIA_HOUSEKEEPING_DEFAULTS, ...(await this.read<Partial<MediaHousekeepingSettings>>(SETTINGS_KEY)) };
  }

  async updateSettings(patch: Partial<MediaHousekeepingSettings>): Promise<MediaHousekeepingStatus> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...(await this.settings()), ...defined };
    await this.write(SETTINGS_KEY, next);
    this.d.log.info('media_housekeeping.settings_updated', { ...next });
    return this.status();
  }

  async tick(now = new Date()) {
    try {
      const settings = await this.settings();
      if (!settings.enabled) return;
      const last = await this.read<MediaHousekeepingRun>(LAST_RUN_KEY);
      if (last && now.getTime() - Date.parse(last.at) < settings.intervalHours * 3600_000) return;
      await this.run({ now, trigger: 'schedule' });
    } catch (err) {
      this.d.log.error('media_housekeeping.failed', { err });
    }
  }

  /** One pass. A dry run changes nothing and reports what a real pass would do. Concurrent real passes share one. */
  async run(o: { now?: Date; dryRun?: boolean; trigger?: MediaHousekeepingRun['trigger'] } = {}): Promise<MediaHousekeepingReport> {
    const now = o.now ?? new Date();
    if (o.dryRun) return this.pass(now, true);
    this.running ??= this.recorded(now, o.trigger ?? 'manual').finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async recorded(now: Date, trigger: MediaHousekeepingRun['trigger']) {
    const run: MediaHousekeepingRun = { at: now.toISOString(), trigger };
    try {
      run.report = await this.pass(now, false);
      return run.report;
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.write(LAST_RUN_KEY, run).catch(() => {});
    }
  }

  private async pass(now: Date, dryRun: boolean): Promise<MediaHousekeepingReport> {
    const s = await this.settings();
    const counts = emptyCounts();
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    let jobsTrashed = 0;

    // 1. old failed jobs and (optional) retention → trash
    const toTrash: string[] = [];
    if (s.hideFailedAfterDays > 0) toTrash.push(...(await this.jobIds(and(eq(mediaJobs.status, 'failed'), lt(mediaJobs.createdAt, ago(s.hideFailedAfterDays))))));
    if (s.retentionDays > 0) toTrash.push(...(await this.jobIds(and(eq(mediaJobs.status, 'completed'), lt(mediaJobs.createdAt, ago(s.retentionDays))))));
    if (toTrash.length) jobsTrashed = dryRun ? new Set(toTrash).size : (await this.d.trash.trash(toTrash, 'system', null)).trashed.length;

    // 2. trash past its grace period → gone
    const expired = await this.d.trash.expired(ago(s.trashGraceDays), BATCH);
    await this.d.trash.purge(
      expired.map((j) => j.id),
      { dryRun, counts },
    );

    // 3. media of chats archived long ago (chat uploads and artifacts; still-used files are kept)
    if (s.archivedChatMediaDays > 0) {
      const convs = await this.d.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(isNotNull(conversations.archivedAt), lt(conversations.archivedAt, ago(s.archivedChatMediaDays)), sql`coalesce(${conversations.metadata}->>'hidden', 'false') <> 'true'`))
        .limit(BATCH);
      if (convs.length) {
        const convIds = convs.map((c) => c.id);
        const msgs = await this.d.db.select({ content: messages.content, artifacts: messages.artifacts }).from(messages).where(inArray(messages.conversationId, convIds));
        const ids = new Set<string>(msgs.flatMap((m) => [...m.content.flatMap((b) => ('fileId' in b ? [b.fileId] : [])), ...m.artifacts.map((a) => a.fileId)]));
        const attached = await this.d.db.select().from(files).where(inArray(files.conversationId, convIds));
        const rows = [...attached, ...(await this.d.trash.fileRows([...ids].filter((id) => !attached.some((f) => f.id === id))))];
        await this.d.trash.removeUnused(rows, { chats: 'active', dryRun, counts });
      }
    }

    // 4. uploads nobody used (archived chats count as users: step 3 decides about those)
    if (s.unusedUploadDays > 0) {
      const rows = await this.d.db
        .select()
        .from(files)
        .where(and(eq(files.kind, 'upload'), lt(files.createdAt, ago(s.unusedUploadDays))))
        .limit(BATCH);
      await this.d.trash.removeUnused(rows, { chats: 'all', dryRun, counts });
    }

    // 5. hidden files past the grace period that an earlier pass kept because something used them then
    const hidden = await this.d.db
      .select()
      .from(files)
      .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, ago(s.trashGraceDays))))
      .limit(BATCH);
    await this.d.trash.removeUnused(hidden, { chats: 'active', dryRun, counts });

    const report: MediaHousekeepingReport = { dryRun, jobsTrashed, ...counts };
    this.d.log.info('media_housekeeping.done', { ...report });
    return report;
  }

  private async jobIds(where: ReturnType<typeof and>): Promise<string[]> {
    const rows = await this.d.db
      .select({ id: mediaJobs.id })
      .from(mediaJobs)
      .where(and(where, isNull(mediaJobs.deletedAt), or(eq(mediaJobs.status, 'completed'), eq(mediaJobs.status, 'failed'))))
      .limit(BATCH);
    return rows.map((r) => r.id);
  }

  private async read<T>(key: string): Promise<T | null> {
    const [row] = await this.d.db.select().from(kv).where(eq(kv.key, key));
    return (row?.value as T | undefined) ?? null;
  }

  private async write(key: string, value: unknown) {
    await this.d.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  }
}
