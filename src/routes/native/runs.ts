import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { INLINE_IMAGE_TYPES, UPLOAD_MAX } from '../../core/attachments.js';
import { isTerminalRun, type RunRow, type RunStepRow } from '../../core/runs/service.js';
import { type ContentBlock, councilResults } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import type { Env } from '../../http.js';
import { body, limitParam, type SseEvent, sse } from './util.js';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export const runView = (r: RunRow) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  progress: r.progress,
  state: r.state,
  result: r.result ?? null,
  error: r.error ?? null,
  credits: r.credits,
  conversation_id: r.conversationId,
  message_id: r.messageId,
  created_at: iso(r.createdAt),
  started_at: iso(r.startedAt),
  completed_at: iso(r.completedAt),
});

/** Inputs stay out of the list view (they carry whole chat transcripts); GET /runs/:id has them. */
const runDetailView = (r: RunRow) => ({ ...runView(r), input: r.input });

export const stepView = (s: RunStepRow) => ({
  key: s.key,
  kind: s.kind,
  status: s.status,
  attempt: s.attempt,
  model: s.model,
  output: s.output ?? null,
  credits: s.credits,
  error: s.error ?? null,
  started_at: iso(s.startedAt),
  completed_at: iso(s.completedAt),
});

const createSchema = z
  .object({
    kind: z.string().min(1),
    /** Kind-specific options. `prompt` + `attachments` (file ids) become the message content. */
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export function runRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.post('/runs', async (c) => {
    const b = await body(c, createSchema);
    const userId = c.get('user').id;
    await ctx.usage.assertWithinLimit(userId);
    const input = await withContent(ctx, userId, b.input);
    const run = await ctx.runs.create({ userId, kind: b.kind, input });
    return c.json(runDetailView(run), 201);
  });

  app.get('/runs', async (c) => {
    const before = c.req.query('before');
    if (before && Number.isNaN(Date.parse(before))) throw new AppError(400, 'validation_error', 'before must be an ISO timestamp (next_cursor)');
    const page = await ctx.runs.list(c.get('user').id, { kind: c.req.query('kind') || undefined, limit: limitParam(c.req.query('limit'), 20, 100), before });
    const last = page.data.at(-1);
    return c.json({ data: page.data.map(runView), has_more: page.hasMore, next_cursor: page.hasMore && last ? last.createdAt.toISOString() : null });
  });

  app.get('/runs/:id', async (c) => {
    const run = await own(ctx, c);
    return c.json({ ...runDetailView(run), steps: (await ctx.runs.steps(run.id)).map(stepView) });
  });

  /**
   * SSE: a `run` snapshot (with steps), then the live events of the run while it executes (`id` = sequence number;
   * resume with Last-Event-ID). Ends when the run settles (terminal or awaiting input).
   */
  app.get('/runs/:id/events', async (c) => {
    const run = await own(ctx, c);
    const after = Number(c.req.header('last-event-id') ?? c.req.query('last_event_id') ?? 0);
    return sse(c, (signal) => runEvents(ctx, run.id, Number.isFinite(after) && after > 0 ? after : 0, signal));
  });

  app.post('/runs/:id/cancel', async (c) => {
    const run = await own(ctx, c);
    return c.json(runView(await ctx.runs.cancel(run.id, run.userId)));
  });

  /** Answers a run waiting for input (`status: awaiting_input`, `state.awaiting` says what it asks). */
  app.post('/runs/:id/input', async (c) => {
    const run = await own(ctx, c);
    const b = await body(c, z.object({ value: z.unknown() }));
    return c.json(runView(await ctx.runs.provideInput(run.id, run.userId, b.value)));
  });

  app.delete('/runs/:id', async (c) => {
    const run = await own(ctx, c);
    await ctx.runs.remove(run.id, run.userId);
    return c.body(null, 204);
  });

  return app;
}

/** Admin: how council members fare (win rate, mean judge score, latency) per model, optionally per category. */
export function runAdminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/admin/council/leaderboard', async (c) => {
    const days = limitParam(c.req.query('days'), 30, 3650);
    const category = c.req.query('category') || undefined;
    const conds = [gte(councilResults.createdAt, new Date(Date.now() - days * 86_400_000))];
    if (category) conds.push(eq(councilResults.category, category));
    const rows = await ctx.database.db
      .select({
        model: councilResults.model,
        runs: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${councilResults.won})::int`,
        failures: sql<number>`count(*) filter (where ${councilResults.failed})::int`,
        mean_rank: sql<number | null>`avg(${councilResults.rank})::float`,
        mean_score: sql<number | null>`avg(${councilResults.score})::float`,
        mean_latency_ms: sql<number | null>`avg(${councilResults.latencyMs})::float`,
      })
      .from(councilResults)
      .where(and(...conds))
      .groupBy(councilResults.model);
    const data = rows
      .map((r) => ({ ...r, win_rate: r.runs ? Math.round((r.wins / r.runs) * 1000) / 1000 : 0 }))
      .sort((a, b) => b.win_rate - a.win_rate || (b.mean_score ?? 0) - (a.mean_score ?? 0));
    const categories = await ctx.database.db
      .select({ category: councilResults.category, runs: sql<number>`count(distinct ${councilResults.runId})::int` })
      .from(councilResults)
      .where(gte(councilResults.createdAt, new Date(Date.now() - days * 86_400_000)))
      .groupBy(councilResults.category)
      .orderBy(desc(sql`2`));
    return c.json({ data, categories, days, category: category ?? null });
  });
  return app;
}

const own = (ctx: AppContext, c: Context<Env>) => ctx.runs.get(c.req.param('id')!, c.get('user').id);

async function* runEvents(ctx: AppContext, id: string, after: number, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const handle = ctx.runs.handle(id);
  const run = await ctx.runs.get(id);
  yield { event: 'run', data: { ...runView(run), steps: (await ctx.runs.steps(id)).map(stepView) } };
  if (!handle || isTerminalRun(run.status) || run.status === 'awaiting_input') return;
  for await (const [seq, e] of handle.iterate(after, signal)) yield { event: e.type, data: e, id: seq };
}

/**
 * `prompt` (text) + `attachments` (file ids: vision images → image blocks, anything else → documents) → `content`
 * blocks the run kinds take. Ownership and sizes are checked here.
 */
async function withContent(ctx: AppContext, userId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { prompt, attachments, ...rest } = input;
  if (prompt === undefined && attachments === undefined) return rest;
  if (prompt !== undefined && typeof prompt !== 'string') throw new AppError(400, 'validation_error', 'input.prompt must be a string');
  const ids = attachments ?? [];
  if (!Array.isArray(ids) || ids.length > 10 || ids.some((x) => typeof x !== 'string')) throw new AppError(400, 'validation_error', 'input.attachments must be at most 10 file ids');
  const content: ContentBlock[] = [];
  if (typeof prompt === 'string' && prompt.trim()) content.push({ type: 'text', text: prompt });
  for (const fileId of ids as string[]) {
    const file = await ctx.store.get(fileId, userId).catch(() => {
      throw new AppError(404, 'file_not_found', `File ${fileId} not found`);
    });
    if (INLINE_IMAGE_TYPES.includes(file.mimeType)) content.push({ type: 'image', fileId: file.id, mimeType: file.mimeType });
    else {
      if (file.size > UPLOAD_MAX) throw new AppError(413, 'attachment_too_large', `${file.filename} exceeds the document limit of ${UPLOAD_MAX / 1024 / 1024} MB`);
      content.push({ type: 'document', fileId: file.id, filename: file.filename, mimeType: file.mimeType });
    }
  }
  if (!content.length) throw new AppError(400, 'empty_message', 'input.prompt or input.attachments is required');
  return { ...rest, content };
}
