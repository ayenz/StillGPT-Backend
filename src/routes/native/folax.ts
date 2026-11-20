import { and, eq, gte, like, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import { mediaJobs, usageEvents, users } from '../../db/schema.js';
import type { Env } from '../../http.js';
import type { FolaxQuota, FolaxUsage } from '../../providers/folax.js';

/**
 * Folax status for the UI: whether the optional Folax features (chat models, image-to-video, prompt edit) can
 * run now, and the shared weekly quota. Folax is a nice-to-have provider: when it is down its features fail, nothing
 * falls back to Qoder.
 */
async function folaxStatus(ctx: AppContext, opts: { fresh?: boolean; admin?: boolean } = {}) {
  if (!ctx.folax) return { configured: false, available: false, status: 'down' as const, checked_at: null, error: { code: 'not_configured', message: 'Folax is not configured' }, usage: null };
  const [upstream, usage] = await Promise.all([ctx.folax.upstream(opts.fresh), ctx.folax.usage(opts.fresh)]);
  return {
    configured: true,
    available: upstream.status !== 'down',
    status: upstream.status,
    checked_at: upstream.checked_at,
    error: upstream.error,
    usage,
    ...(opts.admin ? { latency_ms: upstream.latency_ms, token: upstream.token } : {}),
  };
}

const WEEK_MS = 7 * 24 * 3600_000;

/** Start of the current weekly quota cycle: `reset_at` − 7 days, else the last Monday 00:00 UTC. */
export function cycleStart(usage: FolaxUsage | null, now = new Date()): Date {
  const reset = Date.parse(usage?.video.reset_at ?? usage?.edit.reset_at ?? '');
  if (Number.isFinite(reset)) return new Date(reset - WEEK_MS);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/**
 * What StillGPT itself used this cycle, from our own DB (exact): finished Folax videos and prompt edits (the two that
 * use the shared quota) and Folax chat turns (free), in total and per user. Failed jobs use no
 * quota upstream, so only completed ones count; deleted ones still do.
 */
async function stillgptUsage(ctx: AppContext, since: Date) {
  const db = ctx.database.db;
  const editMode = sql<string | null>`${mediaJobs.request}->'folax_edit'->>'mode'`;
  const jobs = await db
    .select({ userId: mediaJobs.userId, email: users.email, kind: mediaJobs.kind, mode: editMode, n: sql<number>`count(*)::int` })
    .from(mediaJobs)
    .innerJoin(users, eq(users.id, mediaJobs.userId))
    .where(and(eq(mediaJobs.status, 'completed'), gte(mediaJobs.completedAt, since), sql`${mediaJobs.request}->>'provider_used' = 'folax'`))
    .groupBy(mediaJobs.userId, users.email, mediaJobs.kind, editMode);
  const chats = await db
    .select({ userId: usageEvents.userId, email: users.email, n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .where(and(eq(usageEvents.kind, 'chat'), like(usageEvents.model, 'folax/%'), gte(usageEvents.createdAt, since)))
    .groupBy(usageEvents.userId, users.email);

  type Row = { user_id: string; email: string; videos: number; edits: number; chat_turns: number };
  const byUser = new Map<string, Row>();
  const row = (userId: string, email: string) => {
    let r = byUser.get(userId);
    if (!r) byUser.set(userId, (r = { user_id: userId, email, videos: 0, edits: 0, chat_turns: 0 }));
    return r;
  };
  for (const j of jobs) {
    const r = row(j.userId, j.email);
    if (j.kind === 'video') r.videos += j.n;
    else if (j.mode === 'instruction') r.edits += j.n;
    // text-to-image (generate-all) and old remove-people jobs use no weekly quota and are not listed here
  }
  for (const c of chats) row(c.userId, c.email).chat_turns += c.n;
  const users_ = [...byUser.values()].sort((a, b) => b.videos + b.edits - (a.videos + a.edits) || a.email.localeCompare(b.email));
  const sum = (k: keyof Omit<Row, 'user_id' | 'email'>) => users_.reduce((n, r) => n + r[k], 0);
  return {
    since: since.toISOString(),
    videos: sum('videos'),
    edits: sum('edits'),
    chat_turns: sum('chat_turns'),
    by_user: users_,
  };
}

/**
 * Quota used outside StillGPT this cycle (the Folax app on the owner's phone, earlier tests): what Folax says is gone
 * minus what we used. null when Folax has not reported a number this cycle.
 */
const outside = (quota: FolaxQuota | undefined, ours: number) =>
  quota && quota.source === 'observed' && quota.remaining !== null ? Math.max(0, quota.total - quota.remaining - ours) : null;

/** GET /folax/status (any signed-in user; cached ~60 s). */
export function folaxRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/folax/status', async (c) => c.json(await folaxStatus(ctx)));
  return app;
}

/** GET /admin/folax/status: checks Folax now (`fresh`) and adds the token details. Mounted under /admin (requireAdmin). */
export function folaxAdminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/admin/folax/status', async (c) => {
    const status = await folaxStatus(ctx, { fresh: true, admin: true });
    const usage = ctx.folax ? await stillgptUsage(ctx, cycleStart(status.usage)) : null;
    return c.json({
      ...status,
      stillgpt_usage: usage,
      outside_usage: usage
        ? { videos: outside(status.usage?.video, usage.videos), edits: outside(status.usage?.edit, usage.edits) }
        : null,
    });
  });
  return app;
}
