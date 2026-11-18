import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { mediaJobJson } from '../../core/media.js';
import {
  DAYS_MAX,
  GRACE_DAYS_MAX,
  MEDIA_INTERVAL_HOURS_MAX,
  type MediaHousekeepingReport,
  type MediaHousekeepingStatus,
} from '../../core/mediaHousekeeping.js';
import type { TrashItem, TrashResult } from '../../core/trash.js';
import { badRequest } from '../../errors.js';
import type { Env } from '../../http.js';
import { body, limitParam, parse } from './util.js';

const MAX_IDS = 100;
const idsBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(MAX_IDS) }).strict();

/**
 * Gallery deletion for users: jobs go to the trash (hidden at once, deleted for good after the grace period).
 * Users cannot list the trash; they can only undo right after deleting (`POST /jobs/:id/restore`).
 */
export function galleryRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.delete('/jobs/:id', async (c) => {
    await ctx.trash.trashOne(c.req.param('id'), 'user', c.get('user').id);
    return c.body(null, 204);
  });

  app.post('/jobs/delete', async (c) => {
    const b = await body(c, idsBody);
    return c.json(trashResultView(await ctx.trash.trash(b.ids, 'user', c.get('user').id)));
  });

  app.post('/jobs/clear-failed', async (c) => c.json(trashResultView(await ctx.trash.clearFailed(c.get('user').id))));

  app.post('/jobs/:id/restore', async (c) => {
    const userId = c.get('user').id;
    const [restored] = await ctx.trash.restore([c.req.param('id')], userId);
    if (!restored) throw badRequest('Job is not in the trash (or was already deleted for good)', 'not_in_trash');
    return c.json(mediaJobJson(await ctx.media.getJob(restored, userId)));
  });

  app.delete('/images/batches/:id', async (c) => c.json(trashResultView(await ctx.trash.trashBatch(c.req.param('id'), c.get('user').id))));

  return app;
}

/** Admin: the trash of all users and the media housekeeping settings. Mounted under /admin (requireAdmin). */
export function galleryAdminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get('/admin/trash', async (c) => {
    const kind = c.req.query('kind') || undefined;
    if (kind !== undefined && kind !== 'image' && kind !== 'video') throw badRequest('kind must be image or video', 'validation_error');
    const before = c.req.query('before') || undefined;
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw badRequest('before must be an ISO timestamp', 'validation_error');
    const { trashGraceDays } = await ctx.mediaHousekeeper.settings();
    const page = await ctx.trash.list({ graceDays: trashGraceDays, userId: c.req.query('user_id') || undefined, kind, before, limit: limitParam(c.req.query('limit'), 50, 200) });
    return c.json({ data: page.items.map(trashItemView), next_before: page.nextBefore });
  });

  app.post('/admin/trash/restore', async (c) => {
    const b = await body(c, idsBody);
    return c.json({ restored: await ctx.trash.restore(b.ids, null) });
  });

  /** Delete trashed jobs for good now, without waiting for the grace period. */
  app.post('/admin/trash/purge', async (c) => {
    const b = await body(c, idsBody);
    const counts = await ctx.trash.purge(b.ids);
    return c.json({ report: reportView({ dryRun: false, jobsTrashed: 0, ...counts }) });
  });

  app.get('/admin/media-housekeeping', async (c) => c.json(await statusView(ctx)));

  app.patch('/admin/media-housekeeping', async (c) => {
    const days = z.number().int().min(0).max(DAYS_MAX).optional();
    const b = await body(
      c,
      z
        .object({
          enabled: z.boolean().optional(),
          trash_grace_days: z.number().int().min(0).max(GRACE_DAYS_MAX).optional(),
          hide_failed_after_days: days,
          archived_chat_media_days: days,
          unused_upload_days: days,
          retention_days: days,
          interval_hours: z.number().int().min(1).max(MEDIA_INTERVAL_HOURS_MAX).optional(),
        })
        .strict(),
    );
    await ctx.mediaHousekeeper.updateSettings({
      enabled: b.enabled,
      trashGraceDays: b.trash_grace_days,
      hideFailedAfterDays: b.hide_failed_after_days,
      archivedChatMediaDays: b.archived_chat_media_days,
      unusedUploadDays: b.unused_upload_days,
      retentionDays: b.retention_days,
      intervalHours: b.interval_hours,
    });
    return c.json(await statusView(ctx));
  });

  /** Run a pass now; `dry_run: true` only reports what it would do. */
  app.post('/admin/media-housekeeping/run', async (c) => {
    const b = parse(z.object({ dry_run: z.boolean().default(false) }).strict(), await optionalJson(c));
    const report = await ctx.mediaHousekeeper.run({ dryRun: b.dry_run, trigger: 'manual' });
    return c.json({ report: reportView(report), ...(await statusView(ctx)) });
  });

  return app;
}

async function optionalJson(c: Context): Promise<unknown> {
  const raw = (await c.req.text()).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body must be valid JSON', 'invalid_json');
  }
}

const trashResultView = (r: TrashResult) => ({ trashed: r.trashed, skipped: r.skipped });

const trashItemView = (t: TrashItem) => ({
  job: mediaJobJson(t.job),
  user: t.user,
  deleted_at: t.deletedAt,
  deleted_by: t.deletedBy,
  purge_at: t.purgeAt,
  bytes: t.bytes,
});

const reportView = (r: MediaHousekeepingReport) => ({
  dry_run: r.dryRun,
  jobs_trashed: r.jobsTrashed,
  jobs_purged: r.jobsPurged,
  files_deleted: r.filesDeleted,
  files_in_use: r.filesInUse,
  bytes_freed: r.bytesFreed,
  errors: r.errors,
});

async function statusView(ctx: AppContext) {
  const [s, stats]: [MediaHousekeepingStatus, Awaited<ReturnType<AppContext['trash']['stats']>>] = await Promise.all([ctx.mediaHousekeeper.status(), ctx.trash.stats()]);
  return {
    settings: {
      enabled: s.settings.enabled,
      trash_grace_days: s.settings.trashGraceDays,
      hide_failed_after_days: s.settings.hideFailedAfterDays,
      archived_chat_media_days: s.settings.archivedChatMediaDays,
      unused_upload_days: s.settings.unusedUploadDays,
      retention_days: s.settings.retentionDays,
      interval_hours: s.settings.intervalHours,
    },
    source: s.source,
    running: s.running,
    next_run_at: s.nextRunAt,
    last_run: s.lastRun
      ? { at: s.lastRun.at, trigger: s.lastRun.trigger, report: s.lastRun.report ? reportView(s.lastRun.report) : null, error: s.lastRun.error ?? null }
      : null,
    storage: { files: stats.files, bytes: stats.bytes, trash_jobs: stats.trashJobs, trash_files: stats.trashFiles, trash_bytes: stats.trashBytes },
  };
}
