import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { DB } from '../../db/client.js';
import { type ContentBlock, messages as messageRows, runSteps, runs } from '../../db/schema.js';
import { AppError, badRequest, conflict, notFound, toAppError } from '../../errors.js';
import { newId } from '../../ids.js';
import type { Logger } from '../../log.js';
import type { EventBus } from '../bus.js';
import type { ConversationService } from '../conversations.js';
import type { FcmService } from '../fcm.js';
import type { ProfileName } from '../profiles.js';
import type { PushService } from '../push.js';
import type { TurnRunner, VirtualTurnOutcome } from '../turns.js';
import type { WebhookService } from '../webhooks.js';
import { parseJsonReply } from './json.js';
import { Semaphore } from './semaphore.js';

export type RunRow = typeof runs.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;
export type RunStatus = RunRow['status'];

/** Wire event of a run (snake_case JSON, also forwarded into chat turns as `run.event`). */
export type RunEvent = { type: string } & Record<string, unknown>;

/** What a run kind (council, research, film) implements. */
export interface RunKind<I = unknown> {
  kind: string;
  /** "Council", "Research report"… (notifications). */
  label: string;
  /** Validates the stored input (API input is converted by the route first). */
  input: z.ZodType<I>;
  /** Send Web Push / FCM when the run finishes (long runs). */
  notify?: boolean;
  /** Does the work; returns the result JSON. Must be deterministic over completed steps (it is re-entered on resume). */
  execute(rc: RunContext<I>): Promise<Record<string, unknown> & { text?: string }>;
}

export interface TurnStepOptions {
  model: string;
  profile?: ProfileName;
  text?: string;
  content?: ContentBlock[];
  /** Context the session has never seen (chat history transcript). */
  preamble?: string;
  /** Called with each text delta of the reply (live panels). */
  onDelta?: (text: string) => void;
}

export interface TurnStepOutput {
  text: string;
  model: string;
  credits: number;
  conversationId: string;
  ms: number;
}

export interface StepOptions {
  /** Extra attempts after a retryable failure (default 2). */
  retries?: number;
}

/** Thrown inside a run when it has to wait for the user (POST /runs/:id/input). */
class Paused extends Error {}
/** Thrown inside a run after a cancel. */
class Cancelled extends AppError {
  constructor() {
    super(409, 'run_cancelled', 'The run was cancelled');
  }
}

const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminalRun = (s: RunStatus) => TERMINAL.includes(s);
/** Settled = nothing runs right now (terminal, or waiting for input). */
const isSettled = (s: RunStatus) => isTerminalRun(s) || s === 'awaiting_input';

/** Replayable event log of a run that is executing in this process. */
export class RunHandle {
  readonly events: RunEvent[] = [];
  private waiters: (() => void)[] = [];
  private finished = false;

  push(e: RunEvent) {
    this.events.push(e);
    this.wake();
  }

  finish() {
    this.finished = true;
    this.wake();
  }

  get done() {
    return this.finished;
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Events after index `after`, live until the run settles; yields [seq (1-based), event]. */
  async *iterate(after: number, signal?: AbortSignal): AsyncGenerator<[number, RunEvent]> {
    let i = Math.max(0, after);
    const onAbort = () => this.wake();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal?.aborted) {
        while (i < this.events.length) {
          i++;
          yield [i, this.events[i - 1]!];
        }
        if (this.finished) return;
        await new Promise<void>((r) => this.waiters.push(r));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export interface RunServiceDeps {
  db: DB;
  turns: TurnRunner;
  conversations: ConversationService;
  bus: EventBus;
  log: Logger;
  push?: PushService | null;
  fcm?: FcmService | null;
  webhooks?: WebhookService | null;
  /** Runs executing at once (chat-linked runs do not count). */
  runConcurrency: number;
  /** Hidden turns of all runs in flight at once. */
  turnConcurrency: number;
  /** First retry backoff of a failed step (doubles per attempt). Default 1000. */
  retryBaseMs?: number;
}

/**
 * Durable multi-step jobs. A run kind's `execute` asks for step results by key; completed steps are read back from
 * `run_steps` instead of being executed again, so re-entering `execute` (restart, approval) continues where it stopped.
 */
export class RunService {
  private readonly kinds = new Map<string, RunKind<any>>();
  private readonly queue: string[] = [];
  private readonly executing = new Map<string, { handle: RunHandle; abort: AbortController; priority: boolean }>();
  /** Settle waiters by run id (virtual chat turns waiting for their run). */
  private readonly settleWaiters = new Map<string, ((r: RunRow) => void)[]>();
  /** Runs whose chat reply is persisted by a live virtual turn (no need to post it ourselves). */
  private readonly attached = new Set<string>();
  readonly turnSlots: Semaphore;
  private stopped = false;

  constructor(private readonly d: RunServiceDeps) {
    this.turnSlots = new Semaphore(Math.max(1, d.turnConcurrency));
  }

  register(def: RunKind<any>) {
    this.kinds.set(def.kind, def);
  }

  kindsList() {
    return [...this.kinds.keys()];
  }

  private def(kind: string): RunKind<any> {
    const def = this.kinds.get(kind);
    if (!def) throw badRequest(`Unknown run kind '${kind}'`, 'validation_error', { param: 'kind' });
    return def;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Validates and stores a run, then queues it. `priority` runs (chat replies) start at once instead of waiting for a
   * run slot; their turns still share the turn slots.
   */
  async create(o: { userId: string; kind: string; input: unknown; conversationId?: string; messageId?: string; priority?: boolean }): Promise<RunRow> {
    const def = this.def(o.kind);
    const parsed = def.input.safeParse(o.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw badRequest(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), 'validation_error', { issues });
    }
    const [row] = await this.d.db
      .insert(runs)
      .values({
        id: newId('run'),
        userId: o.userId,
        kind: o.kind,
        input: parsed.data as Record<string, unknown>,
        conversationId: o.conversationId ?? null,
        messageId: o.messageId ?? null,
        state: o.priority ? { priority: true } : {},
      })
      .returning();
    this.enqueue(row!.id, !!o.priority);
    return row!;
  }

  /** Re-queue runs that were queued or running when the process stopped. Call once at startup. */
  async start() {
    const rows = await this.d.db
      .select({ id: runs.id, state: runs.state })
      .from(runs)
      .where(and(inArray(runs.status, ['queued', 'running']), isNull(runs.deletedAt)))
      .orderBy(asc(runs.createdAt));
    for (const r of rows) this.enqueue(r.id, !!r.state?.priority);
    if (rows.length) this.d.log.info('runs.resumed', { runs: rows.map((r) => r.id) });
  }

  async stop() {
    this.stopped = true;
    for (const e of this.executing.values()) e.abort.abort(new Error('shutdown'));
  }

  async get(id: string, userId?: string): Promise<RunRow> {
    const where = userId ? and(eq(runs.id, id), eq(runs.userId, userId)) : eq(runs.id, id);
    const [row] = await this.d.db.select().from(runs).where(and(where, isNull(runs.deletedAt)));
    if (!row) throw notFound('Run');
    return row;
  }

  async steps(runId: string): Promise<RunStepRow[]> {
    return this.d.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.startedAt));
  }

  /** Newest first; cursor = created_at ISO of the last item. */
  async list(userId: string, o: { kind?: string; limit?: number; before?: string } = {}) {
    const limit = Math.min(o.limit ?? 20, 100);
    const conds = [eq(runs.userId, userId), isNull(runs.deletedAt)];
    if (o.kind) conds.push(eq(runs.kind, o.kind));
    if (o.before) conds.push(lt(runs.createdAt, new Date(o.before)));
    const rows = await this.d.db.select().from(runs).where(and(...conds)).orderBy(desc(runs.createdAt)).limit(limit + 1);
    return { data: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /** The live event log of a run executing in this process. */
  handle(id: string): RunHandle | undefined {
    return this.executing.get(id)?.handle;
  }

  async cancel(id: string, userId: string): Promise<RunRow> {
    const row = await this.get(id, userId);
    if (isTerminalRun(row.status)) return row;
    const live = this.executing.get(id);
    if (live) {
      live.abort.abort(new Cancelled());
      return (await this.waitForSettled(id)) ?? (await this.get(id));
    }
    return this.settle(row, 'cancelled', { error: { code: 'run_cancelled', message: 'The run was cancelled' } });
  }

  /** Answers a run that waits for input (`awaiting_input`) and resumes it. */
  async provideInput(id: string, userId: string, value: unknown): Promise<RunRow> {
    const row = await this.get(id, userId);
    if (row.status !== 'awaiting_input') throw conflict('This run is not waiting for input', 'run_not_waiting');
    const [pending] = await this.d.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, id), eq(runSteps.kind, 'input'), eq(runSteps.status, 'running')));
    if (!pending) throw conflict('This run is not waiting for input', 'run_not_waiting');
    await this.d.db.update(runSteps).set({ status: 'completed', output: { value: value ?? null }, completedAt: new Date() }).where(eq(runSteps.id, pending.id));
    const { awaiting: _awaiting, ...state } = row.state ?? {};
    const [updated] = await this.d.db.update(runs).set({ status: 'queued', state }).where(eq(runs.id, id)).returning();
    this.enqueue(id, !!state.priority);
    return updated!;
  }

  /** Soft delete; a live run is cancelled first. */
  async remove(id: string, userId: string) {
    const row = await this.get(id, userId);
    if (!isTerminalRun(row.status)) await this.cancel(id, userId);
    await this.d.db.update(runs).set({ deletedAt: new Date() }).where(eq(runs.id, id));
  }

  /** Resolves when the run is terminal or waits for input (null if it is not executing and never settles here). */
  waitForSettled(id: string): Promise<RunRow | null> {
    return new Promise((resolve) => {
      const list = this.settleWaiters.get(id) ?? [];
      list.push(resolve);
      this.settleWaiters.set(id, list);
    });
  }

  // ── chat integration ─────────────────────────────────────────────────────

  /**
   * Registers a virtual chat model backed by a run kind: a chat turn on `modelId` creates a run (input from `toInput`)
   * linked to the conversation, forwards its events into the turn, streams `run.text.delta` as the reply text and
   * returns the run's `result.text`. Interrupting the turn cancels the run.
   */
  registerVirtualModel(modelId: string, kind: string, toInput: (o: { content: ContentBlock[]; preamble?: string; modelId: string }) => unknown) {
    this.d.turns.registerVirtualModel(modelId, async ({ conversation, req, messageId, userMessageId, emit, signal }): Promise<VirtualTurnOutcome> => {
      const preamble = req.preamble ?? (await this.historyPreamble(conversation.id, userMessageId));
      const run = await this.create({
        userId: req.userId,
        kind,
        input: toInput({ content: req.content, preamble, modelId }),
        conversationId: conversation.id,
        messageId,
        priority: true,
      });
      this.attached.add(run.id);
      const forward = new AbortController();
      const onAbort = () => void this.cancel(run.id, req.userId).catch(() => {});
      signal.addEventListener('abort', onAbort, { once: true });
      const settled = this.waitForSettled(run.id);
      const pump = (async () => {
        // the run starts right away (priority); wait for its handle
        for (let i = 0; i < 100 && !this.handle(run.id) && !forward.signal.aborted; i++) await new Promise((r) => setTimeout(r, 20));
        const h = this.handle(run.id);
        if (!h) return;
        for await (const [, e] of h.iterate(0, forward.signal)) {
          if (e.type === 'run.text.delta') emit({ type: 'text.delta', text: String(e.text ?? '') });
          else emit({ type: 'run.event', runId: run.id, event: e });
        }
      })();
      try {
        const done = (await settled) ?? (await this.get(run.id));
        forward.abort();
        await pump.catch(() => {});
        const text = typeof done.result?.text === 'string' ? done.result.text : '';
        if (done.status === 'completed') return { text, model: modelId };
        if (done.status === 'cancelled') return { text, model: modelId, stopReason: 'interrupted' };
        return { text, model: modelId, error: done.error ?? { code: 'run_failed', message: 'The run failed' } };
      } finally {
        signal.removeEventListener('abort', onAbort);
        this.attached.delete(run.id);
      }
    });
  }

  /** Recent chat history as a transcript for workers that start without the conversation's session. */
  private async historyPreamble(conversationId: string, excludeMessageId: string): Promise<string | undefined> {
    const recent = await this.d.db
      .select()
      .from(messageRows)
      .where(eq(messageRows.conversationId, conversationId))
      .orderBy(desc(messageRows.createdAt))
      .limit(41);
    const msgs = recent.reverse().filter((m) => m.id !== excludeMessageId);
    if (!msgs.length) return undefined;
    const lines = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')}`);
    return `Conversation so far (for context — continue from it):\n\n${lines.join('\n\n')}\n\n---\nNew message from the user:`;
  }

  // ── execution ────────────────────────────────────────────────────────────

  private enqueue(id: string, priority: boolean) {
    if (this.stopped || this.executing.has(id) || this.queue.includes(id)) return;
    if (priority) {
      void this.execute(id, true);
      return;
    }
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    const busy = [...this.executing.values()].filter((e) => !e.priority).length;
    let free = this.d.runConcurrency - busy;
    while (free-- > 0 && this.queue.length) void this.execute(this.queue.shift()!, false).finally(() => this.pump());
  }

  private async execute(id: string, priority: boolean) {
    if (this.executing.has(id)) return;
    const handle = new RunHandle();
    const abort = new AbortController();
    this.executing.set(id, { handle, abort, priority });
    let row: RunRow | undefined;
    try {
      row = await this.get(id);
      if (row.status !== 'queued' && row.status !== 'running') return;
      const def = this.def(row.kind);
      [row] = await this.d.db.update(runs).set({ status: 'running', startedAt: row.startedAt ?? new Date() }).where(eq(runs.id, id)).returning();
      const steps = await this.steps(id);
      const rc = new RunContext(this, row!, def.input.parse(row!.input), steps, handle, abort.signal);
      rc.emit({ type: 'run.started', run_id: id, kind: row!.kind });
      const result = await def.execute(rc);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Cancelled();
      await this.settle(row!, 'completed', { result, handle });
    } catch (err) {
      if (!row) {
        this.d.log.error('runs.load_failed', { runId: id, err });
        return;
      }
      if (err instanceof Paused) {
        const [r] = await this.d.db.update(runs).set({ status: 'awaiting_input', credits: await this.creditsOf(id) }).where(eq(runs.id, id)).returning();
        handle.push({ type: 'run.awaiting_input', run_id: id, awaiting: r!.state?.awaiting ?? null });
        this.resolveWaiters(r!);
        return;
      }
      const reason = abort.signal.aborted ? abort.signal.reason : err;
      if (reason instanceof Error && reason.message === 'shutdown') return; // resumed on the next start
      if (reason instanceof Cancelled) {
        await this.settle(row, 'cancelled', { error: { code: reason.code, message: reason.message }, handle });
        return;
      }
      const e = toAppError(err);
      this.d.log.error('runs.failed', { runId: id, kind: row.kind, code: e.code, err: e.message });
      await this.settle(row, 'failed', { error: { code: e.code, message: e.message }, handle });
    } finally {
      handle.finish();
      this.executing.delete(id);
    }
  }

  private async creditsOf(runId: string): Promise<number> {
    const [r] = await this.d.db
      .select({ total: sql<number>`coalesce(sum(${runSteps.credits}), 0)` })
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    return Math.round(Number(r?.total ?? 0) * 10000) / 10000;
  }

  private async settle(
    row: RunRow,
    status: 'completed' | 'failed' | 'cancelled',
    o: { result?: Record<string, unknown>; error?: { code: string; message: string }; handle?: RunHandle },
  ): Promise<RunRow> {
    const [updated] = await this.d.db
      .update(runs)
      .set({
        status,
        result: o.result ?? null,
        error: o.error ?? null,
        progress: status === 'completed' ? 100 : row.progress,
        credits: await this.creditsOf(row.id),
        completedAt: new Date(),
      })
      .where(eq(runs.id, row.id))
      .returning();
    const r = updated!;
    o.handle?.push(
      status === 'completed'
        ? { type: 'run.completed', run_id: r.id, result: r.result, credits: r.credits }
        : { type: `run.${status}`, run_id: r.id, error: r.error },
    );
    await this.postChatReply(r).catch((err) => this.d.log.error('runs.chat_reply_failed', { runId: r.id, err }));
    this.resolveWaiters(r);
    void this.notify(r);
    return r;
  }

  /** A chat-linked run that finished after its turn was lost (restart): post the reply ourselves, once. */
  private async postChatReply(r: RunRow) {
    if (!r.conversationId || !r.messageId || this.attached.has(r.id)) return;
    const [exists] = await this.d.db.select({ id: messageRows.id }).from(messageRows).where(eq(messageRows.id, r.messageId));
    if (exists) return;
    const text = typeof r.result?.text === 'string' ? r.result.text : '';
    await this.d.conversations.addMessage({
      id: r.messageId,
      conversationId: r.conversationId,
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      model: r.kind,
      credits: r.credits,
      stopReason: r.status === 'completed' ? 'end_turn' : r.status === 'cancelled' ? 'interrupted' : 'error',
      error: r.error ?? null,
    });
  }

  private resolveWaiters(r: RunRow) {
    const list = this.settleWaiters.get(r.id);
    if (!list) return;
    this.settleWaiters.delete(r.id);
    list.forEach((f) => f(r));
  }

  private async notify(r: RunRow) {
    if (r.status === 'cancelled') return;
    const def = this.kinds.get(r.kind);
    const ok = r.status === 'completed';
    await this.d.webhooks?.emit(r.userId, ok ? 'run.completed' : 'run.failed', { run: { id: r.id, kind: r.kind, status: r.status, error: r.error } }).catch(() => {});
    if (!def?.notify) return;
    const label = def.label;
    const path = r.conversationId ? `/chat/${r.conversationId}` : `/runs/${r.id}`;
    const title = ok ? `${label} ready` : `${label} failed`;
    const body = ok ? 'Tap to open it.' : (r.error?.message ?? 'Something went wrong.').slice(0, 140);
    await Promise.all([
      this.d.push?.enabled ? this.d.push.notify(r.userId, { title, body, url: path, tag: `run-${r.id}` }) : null,
      this.d.fcm?.enabled ? this.d.fcm.notify(r.userId, { title, body, tag: r.id, data: { type: 'run', run_id: r.id, kind: r.kind, path } }) : null,
    ]).catch((err) => this.d.log.warn('runs.notify_failed', { runId: r.id, err }));
  }

  // ── used by RunContext ───────────────────────────────────────────────────

  /** @internal */
  publish(runId: string, handle: RunHandle, e: RunEvent) {
    handle.push(e);
    this.d.bus.publish(`run:${runId}`, e);
  }

  /** @internal */
  get deps() {
    return this.d;
  }

  /** @internal */
  pause(): never {
    throw new Paused();
  }

  /** @internal */
  cancelledError() {
    return new Cancelled();
  }
}

/** The API a run kind's `execute` works with. */
export class RunContext<I> {
  private readonly done = new Map<string, RunStepRow>();
  private stateCache: Record<string, unknown>;

  constructor(
    private readonly svc: RunService,
    readonly run: RunRow,
    readonly input: I,
    steps: RunStepRow[],
    private readonly handle: RunHandle,
    readonly signal: AbortSignal,
  ) {
    for (const s of steps) if (s.status === 'completed') this.done.set(s.key, s);
    this.stateCache = { ...(run.state ?? {}) };
  }

  get userId() {
    return this.run.userId;
  }

  get state(): Readonly<Record<string, unknown>> {
    return this.stateCache;
  }

  emit(e: RunEvent) {
    this.svc.publish(this.run.id, this.handle, e);
  }

  /** Streams part of the final answer (chat-linked runs show it as the reply text). */
  answerDelta(text: string) {
    if (text) this.emit({ type: 'run.text.delta', text });
  }

  /** Merges into `runs.state` and tells listeners. */
  async setState(patch: Record<string, unknown>) {
    this.stateCache = { ...this.stateCache, ...patch };
    await this.svc.deps.db.update(runs).set({ state: this.stateCache }).where(eq(runs.id, this.run.id));
    this.emit({ type: 'run.state', state: patch });
  }

  async stage(stage: string, label: string, progress: number) {
    await this.svc.deps.db.update(runs).set({ progress: Math.round(progress), state: { ...this.stateCache, stage, stage_label: label } }).where(eq(runs.id, this.run.id));
    this.stateCache = { ...this.stateCache, stage, stage_label: label };
    this.emit({ type: 'run.stage', stage, label, progress: Math.round(progress) });
  }

  checkCancelled() {
    if (this.signal.aborted) throw this.signal.reason instanceof Error ? this.signal.reason : this.svc.cancelledError();
  }

  /** Output of a step that already completed (in this or an earlier execution), if any. */
  completed<T>(key: string): T | undefined {
    return this.done.get(key)?.output as T | undefined;
  }

  /**
   * Runs `exec` once per (run, key): a completed step returns its stored output. Retryable failures (429/5xx) are
   * retried with backoff; the final failure is stored on the step and thrown.
   */
  async step<T>(key: string, kind: RunStepRow['kind'], exec: (stepId: string) => Promise<{ output: T; model?: string | null; credits?: number; conversationId?: string | null; jobId?: string | null }>, o: StepOptions = {}): Promise<T> {
    const hit = this.done.get(key);
    if (hit) return hit.output as T;
    const db = this.svc.deps.db;
    const retries = o.retries ?? 2;
    for (let attempt = 1; ; attempt++) {
      this.checkCancelled();
      const [row] = await db
        .insert(runSteps)
        .values({ id: newId('rstep'), runId: this.run.id, key, kind, status: 'running', attempt })
        .onConflictDoUpdate({ target: [runSteps.runId, runSteps.key], set: { status: 'running', attempt, error: null, startedAt: new Date(), completedAt: null } })
        .returning();
      this.emit({ type: 'step.started', key, attempt });
      try {
        const r = await exec(row!.id);
        const [saved] = await db
          .update(runSteps)
          .set({
            status: 'completed',
            output: r.output as unknown,
            model: r.model ?? null,
            credits: r.credits ?? 0,
            conversationId: r.conversationId ?? null,
            jobId: r.jobId ?? null,
            completedAt: new Date(),
          })
          .where(eq(runSteps.id, row!.id))
          .returning();
        this.done.set(key, saved!);
        this.emit({ type: 'step.completed', key, model: r.model ?? null, credits: r.credits ?? 0 });
        return r.output;
      } catch (err) {
        const cancelled = this.signal.aborted;
        const e = toAppError(err);
        await db.update(runSteps).set({ status: 'failed', error: { code: e.code, message: e.message }, completedAt: new Date() }).where(eq(runSteps.id, row!.id));
        if (cancelled) throw this.signal.reason instanceof Error ? this.signal.reason : err;
        if (!e.retryable || attempt > retries) {
          this.emit({ type: 'step.failed', key, error: { code: e.code, message: e.message } });
          throw e;
        }
        this.emit({ type: 'step.retry', key, attempt, error: { code: e.code, message: e.message } });
        await sleep((this.svc.deps.retryBaseMs ?? 1000) * 2 ** (attempt - 1), this.signal).catch(() => {});
      }
    }
  }

  /** Optional work (one of many answers): a final failure gives `undefined`; a cancel still propagates. */
  async optional<T>(work: Promise<T>): Promise<T | undefined> {
    try {
      return await work;
    } catch {
      this.checkCancelled();
      return undefined;
    }
  }

  /** One hidden one-shot chat turn as a step. A failed or empty reply is a retryable error. */
  turn(key: string, o: TurnStepOptions, so?: StepOptions): Promise<TurnStepOutput> {
    return this.step<TurnStepOutput>(key, 'turn', async (stepId) => this.runTurn(key, stepId, o), so);
  }

  /**
   * A turn whose reply must be JSON matching `schema`. A reply that does not parse counts as a retryable failure, and
   * the retry is told what was wrong.
   */
  async turnJson<T extends z.ZodType>(key: string, o: TurnStepOptions & { schema: T }, so?: StepOptions): Promise<z.infer<T> & { _model: string }> {
    let lastError = '';
    const out = await this.step<{ value: z.infer<T>; model: string }>(
      key,
      'turn',
      async (stepId) => {
        const text = lastError ? `${o.text ?? ''}\n\nYour previous reply could not be used (${lastError}). Reply with ONLY the JSON object.` : o.text;
        const r = await this.runTurn(key, stepId, { ...o, text });
        const parsed = parseJsonReply(r.text, o.schema);
        if (!parsed.ok) {
          lastError = parsed.error;
          throw new AppError(502, 'invalid_json_reply', `${r.model} replied without the expected JSON: ${parsed.error}`);
        }
        return { output: { value: parsed.value, model: r.model }, model: r.model, credits: r.credits, conversationId: r.conversationId };
      },
      so,
    );
    return { ...(out.value as object), _model: out.model } as z.infer<T> & { _model: string };
  }

  private async runTurn(key: string, stepId: string, o: TurnStepOptions): Promise<{ output: TurnStepOutput } & TurnStepOutput> {
    const { turns, conversations, db } = this.svc.deps;
    const release = await this.svc.turnSlots.acquire(this.signal);
    const started = Date.now();
    try {
      const conv = await conversations.create({
        userId: this.userId,
        profile: o.profile ?? 'chat',
        model: o.model,
        title: `${this.run.kind}: ${key}`,
        metadata: { hidden: true, purpose: 'run', run_id: this.run.id, step: key },
      });
      await db.update(runSteps).set({ conversationId: conv.id, model: o.model }).where(eq(runSteps.id, stepId));
      const content: ContentBlock[] = o.content ?? [{ type: 'text', text: o.text ?? '' }];
      if (o.content && o.text) content.unshift({ type: 'text', text: o.text });
      const handle = await turns.start({ conversationId: conv.id, userId: this.userId, oneShot: true, content, preamble: o.preamble, kind: 'chat', allowFolax: true });
      const onAbort = () => void turns.interrupt(conv.id, this.userId).catch(() => {});
      this.signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (o.onDelta) for await (const e of handle.iterate()) if (e.type === 'text.delta') o.onDelta(e.text);
        const r = await handle.done;
        this.checkCancelled();
        if (r.stopReason === 'error') throw new AppError(502, r.error?.code ?? 'upstream_error', r.error?.message ?? 'The turn failed');
        if (!r.text.trim()) throw new AppError(502, 'empty_reply', `${r.model || o.model} returned an empty reply`);
        const out: TurnStepOutput = { text: r.text, model: r.model, credits: r.credits.total, conversationId: conv.id, ms: Date.now() - started };
        return { output: out, ...out };
      } finally {
        this.signal.removeEventListener('abort', onAbort);
      }
    } finally {
      release();
    }
  }

  /**
   * Waits for the user: the first time, stores `ask` (shown by the UI), sets the run to `awaiting_input` and stops
   * executing. POST /runs/:id/input stores the answer and re-enters the run, where this returns that answer.
   */
  async awaitInput<T>(key: string, ask: Record<string, unknown>): Promise<T | null> {
    const hit = this.done.get(key);
    if (hit) return ((hit.output as { value?: T } | null)?.value ?? null) as T | null;
    const db = this.svc.deps.db;
    await db
      .insert(runSteps)
      .values({ id: newId('rstep'), runId: this.run.id, key, kind: 'input', status: 'running', output: ask })
      .onConflictDoUpdate({ target: [runSteps.runId, runSteps.key], set: { status: 'running', output: ask } });
    this.stateCache = { ...this.stateCache, awaiting: { key, ...ask } };
    await db.update(runs).set({ state: this.stateCache }).where(eq(runs.id, this.run.id));
    return this.svc.pause();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
