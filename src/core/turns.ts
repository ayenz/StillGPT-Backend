import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { type ArtifactRef, type ContentBlock, conversations, messages as messageRows } from '../db/schema.js';
import { AppError, conflict, toAppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import type { FolaxClient } from '../providers/folax.js';
import { isModelUnavailable, type QoderClient } from '../qoder/client.js';
import type { QoderContentBlock, QoderEvent, QoderStreamFrame } from '../qoder/types.js';
import { AGENT_BASE_MODEL, type AgentPool } from './agentPool.js';
import { prepareInput, reupload } from './attachments.js';
import type { EventBus } from './bus.js';
import { assertFolaxContent, buildFolaxMessages, FOLAX_MODEL_PREFIX, isFolaxModelId } from './folaxChat.js';
import type { ConversationRow, ConversationService } from './conversations.js';
import { type Artifact, type Credits, type StopReason, type TurnEvent, zeroCredits } from './events.js';
import type { ModelRegistry } from './models.js';
import { DOCUMENT_TOOLS, PROFILES, type ProfileName } from './profiles.js';
import type { MediaStore } from './storage.js';
import type { UsageService } from './usage.js';

/** Upper bound for one turn (video generation may block up to 30 min upstream). */
const TURN_TIMEOUT_MS = 45 * 60_000;
/** A conversation stuck in `busy` longer than this is considered abandoned (process crash). */
const STALE_BUSY_MS = TURN_TIMEOUT_MS + 5 * 60_000;
const MAX_STREAM_RECONNECTS = 5;
const MAX_MODEL_RETRIES = 3;

export interface StartTurn {
  conversationId: string;
  userId: string;
  content: ContentBlock[];
  /** Transcript of earlier history the session has never seen (stateless clients, lost sessions). */
  preamble?: string;
  kind?: 'chat' | 'image' | 'video';
  jobId?: string;
  /**
   * The conversation is used for this single turn only (titler, enhancer, media jobs): its Qoder session is archived
   * as soon as the turn ends instead of lingering until housekeeping.
   */
  oneShot?: boolean;
  /**
   * Awaited after the result is persisted and before `turn.completed` is emitted (e.g. compat thread bookkeeping).
   * Events it returns are emitted right before `turn.completed` (e.g. `conversation.title`).
   */
  beforeComplete?: (result: TurnResult) => Promise<TurnEvent[] | void>;
}

export interface TurnResult {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  model: string;
  text: string;
  artifacts: Artifact[];
  credits: Credits;
  stopReason: StopReason;
  error?: { code: string; message: string };
}

/** Replayable event log of one running turn: late subscribers get everything from the start. */
export class TurnHandle {
  readonly events: TurnEvent[] = [];
  private waiters: (() => void)[] = [];
  private finished = false;
  readonly done: Promise<TurnResult>;
  private resolveDone!: (r: TurnResult) => void;

  constructor(
    readonly conversationId: string,
    readonly userMessageId: string,
    readonly messageId: string,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  push(e: TurnEvent) {
    this.events.push(e);
    this.wake();
  }

  finish(result: TurnResult) {
    this.finished = true;
    this.resolveDone(result);
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    let i = 0;
    const onAbort = () => this.wake();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal?.aborted) {
        while (i < this.events.length) yield this.events[i++]!;
        if (this.finished) return;
        await new Promise<void>((r) => this.waiters.push(r));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

interface AppliedConfig {
  model: string;
  system: string;
  tools: string[];
}

interface RunState {
  handle: TurnHandle;
  conv: ConversationRow;
  req: StartTurn;
  sessionId: string;
  lastEventId: string | null;
  model: string;
  texts: string[];
  deltaIds: Set<string>;
  thinkingIds: Set<string>;
  artifacts: Artifact[];
  pending: Promise<void>[];
  usage: Credits | null;
  error?: { code: string; message: string };
  modelUnavailable: boolean;
}

export interface TurnRunnerDeps {
  db: DB;
  qoder: QoderClient;
  agents: AgentPool;
  models: ModelRegistry;
  store: MediaStore;
  usage: UsageService;
  conversations: ConversationService;
  bus: EventBus;
  log: Logger;
  sessionBudgetCredits?: number;
  /** Folax adapter for `folax/…` chat models; null/absent when not configured. */
  folax?: FolaxClient | null;
}

/**
 * Runs turns on conversations (= Qoder sessions). A turn runs detached from the HTTP request that
 * started it: events go to a replayable TurnHandle and to the bus (`conv:<id>`), results are persisted.
 */
export class TurnRunner {
  private readonly active = new Map<string, TurnHandle>();
  /** Running Folax turns by conversation id, for `interrupt` (they have no Qoder session to interrupt). */
  private readonly folaxAborts = new Map<string, AbortController>();

  constructor(private readonly d: TurnRunnerDeps) {}

  /** The running turn of a conversation, if any (for reconnecting clients). */
  get(conversationId: string): TurnHandle | undefined {
    return this.active.get(conversationId);
  }

  /** Validates, locks the conversation, stores the user message and starts the turn in the background. */
  async start(req: StartTurn): Promise<TurnHandle> {
    await this.d.usage.assertWithinLimit(req.userId);
    const conv = await this.d.conversations.get(req.conversationId, req.userId);
    // before anything is stored: what a Folax model cannot do fails here with a clear 4xx/503
    if (isFolaxModelId(conv.model)) this.assertFolaxTurn(conv, req);
    await this.lock(conv.id);
    try {
      const userMsg = await this.d.conversations.addMessage({ conversationId: conv.id, role: 'user', content: req.content });
      const handle = new TurnHandle(conv.id, userMsg.id, newId('msg'));
      this.active.set(conv.id, handle);
      void this.run(handle, conv, req);
      return handle;
    } catch (err) {
      await this.unlock(conv.id);
      throw err;
    }
  }

  /** Ask the agent to stop the running turn (it ends with stopReason `interrupted`). */
  async interrupt(conversationId: string, userId: string) {
    const conv = await this.d.conversations.get(conversationId, userId);
    const folaxTurn = this.folaxAborts.get(conv.id);
    if (folaxTurn) {
      folaxTurn.abort();
      return true;
    }
    if (!conv.qoderSessionId || conv.status !== 'busy') return false;
    await this.d.qoder.sendEvents(conv.qoderSessionId, [{ type: 'user.interrupt' }]);
    return true;
  }

  /** Startup recovery: conversations left `busy` by a crash are released (their turn is marked failed). */
  async recoverAbandoned() {
    const stuck = await this.d.db
      .update(conversations)
      .set({ status: 'idle', busySince: null })
      .where(eq(conversations.status, 'busy'))
      .returning({ id: conversations.id });
    if (stuck.length) this.d.log.warn('turns.recovered_abandoned', { conversations: stuck.map((s) => s.id) });
    return stuck.map((s) => s.id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async run(handle: TurnHandle, conv: ConversationRow, req: StartTurn) {
    const log = this.d.log.child({ conversationId: conv.id, messageId: handle.messageId });
    const emit = (e: TurnEvent) => {
      handle.push(e);
      this.d.bus.publish(`conv:${conv.id}`, e);
    };
    const st: RunState = {
      handle,
      conv,
      req,
      sessionId: '',
      lastEventId: conv.lastEventId,
      model: conv.resolvedModel ?? '',
      texts: [],
      deltaIds: new Set(),
      thinkingIds: new Set(),
      artifacts: [],
      pending: [],
      usage: null,
      modelUnavailable: false,
    };
    let stopReason: StopReason = 'error';
    const folaxTurn = isFolaxModelId(conv.model);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), TURN_TIMEOUT_MS);

    try {
      if (folaxTurn) {
        stopReason = await this.runFolax(st, emit, timeout.signal);
      } else {
        const profileTools = (PROFILES[conv.profile as ProfileName] ?? PROFILES.chat).tools;
        const input = await prepareInput(req.content, this.d.store, this.d.qoder, req.userId, { mountImages: profileTools.length > 0 });
        let preamble = req.preamble;

        for (let attempt = 0; ; attempt++) {
          const ensured = await this.ensureSession(st, input.hasDocuments, emit);
          if (ensured.recreated && !preamble) preamble = await this.historyPreamble(conv.id, handle.userMessageId);
          if (attempt === 0) emit({ type: 'turn.started', conversationId: conv.id, messageId: handle.messageId, model: st.model });

          for (const m of input.mounts) await this.mount(st.sessionId, m, req.userId);
          const content: QoderContentBlock[] = preamble ? [{ type: 'text', text: preamble }, ...input.content] : input.content;

          stopReason = await this.pump(st, content, emit, timeout.signal);
          await Promise.all(st.pending);

          if (st.modelUnavailable && attempt < MAX_MODEL_RETRIES) {
            log.warn('turn.model_unavailable_retry', { model: st.model });
            await this.d.models.markUnavailable(st.model);
            Object.assign(st, { texts: [], modelUnavailable: false, error: undefined });
            continue;
          }
          break;
        }
      }
    } catch (err) {
      const e = timeout.signal.aborted ? new AppError(504, 'turn_timeout', 'The turn took too long and was stopped') : toAppError(err);
      log.error('turn.failed', { code: e.code, err: e.message });
      st.error = { code: e.code, message: e.message };
      emit({ type: 'error', code: e.code, message: e.message, retryable: e.retryable });
      stopReason = 'error';
    } finally {
      clearTimeout(timer);
    }

    const credits = await this.creditsDelta(st);
    const text = st.texts.join('\n\n');
    const result: TurnResult = {
      conversationId: conv.id,
      userMessageId: handle.userMessageId,
      messageId: handle.messageId,
      model: st.model,
      text,
      artifacts: st.artifacts,
      credits,
      stopReason,
      ...(st.error ? { error: st.error } : {}),
    };

    let extra: TurnEvent[] = [];
    try {
      await this.persist(st, result);
      // Folax turns cost no credits; `free` still counts them in the usage stats
      await this.d.usage.record({ userId: req.userId, kind: req.kind ?? 'chat', model: st.model, conversationId: conv.id, jobId: req.jobId, credits, ...(folaxTurn ? { free: true } : {}) });
      extra = (await req.beforeComplete?.(result)) ?? [];
    } catch (err) {
      log.error('turn.persist_failed', { err });
    } finally {
      this.active.delete(conv.id);
      await this.unlock(conv.id).catch(() => {});
    }

    if (credits.total > 0) emit({ type: 'usage', credits });
    for (const e of extra) emit(e);
    emit({ type: 'turn.completed', messageId: handle.messageId, stopReason, text, artifacts: st.artifacts, credits });
    handle.finish(result);
    if (req.oneShot) void this.releaseSession(conv.id);
  }

  /** Chat-only, configured, not known down, and content a Folax model can take. Throws before anything is stored. */
  private assertFolaxTurn(conv: ConversationRow, req: StartTurn) {
    if (req.oneShot || req.kind === 'image' || req.kind === 'video' || conv.metadata?.hidden)
      throw new AppError(400, 'model_not_supported', 'Folax models are only available for chat', { param: 'model' });
    this.assertFolaxRequest(conv.model, req.content);
  }

  /**
   * The model/content part of the Folax checks, for callers that must fail before creating or updating a conversation
   * (OpenAI/Anthropic compat). No-op for non-Folax models.
   */
  assertFolaxRequest(model: string, content: ContentBlock[]) {
    if (!isFolaxModelId(model)) return;
    this.d.models.resolve(model); // unknown folax/… → 400 model_not_found; not configured → 400 provider_unavailable
    if (!this.d.folax) throw new AppError(400, 'provider_unavailable', 'Folax models are not configured on this server', { param: 'model' });
    if (this.d.folax.knownDown()) throw new AppError(503, 'provider_unavailable', 'Folax is unavailable right now', { provider: 'folax' });
    assertFolaxContent(content);
  }

  /**
   * One turn on a Folax chat model (`folax/<model>`): stateless, so the context is rebuilt from our DB every time.
   * `turn.started` is emitted only once the adapter accepted the request, so early failures (busy, down, bad request)
   * reach compat clients as plain HTTP errors. Interrupt aborts the request and keeps the partial text.
   */
  private async runFolax(st: RunState, emit: (e: TurnEvent) => void, signal: AbortSignal): Promise<StopReason> {
    const { conv, req, handle } = st;
    const folax = this.d.folax;
    st.model = conv.model.trim().toLowerCase();
    const interrupt = new AbortController();
    this.folaxAborts.set(conv.id, interrupt);
    let text = '';
    try {
      if (!folax) throw new AppError(503, 'provider_unavailable', 'Folax models are not configured on this server');
      const res = this.d.models.resolve(conv.model);
      st.model = res.model;

      const profile = PROFILES.chat; // no tools on Folax, whatever the conversation's profile
      // the newest 200 messages (more never fit the adapter's limits), oldest first
      const recent = await this.d.db.select().from(messageRows).where(eq(messageRows.conversationId, conv.id)).orderBy(desc(messageRows.createdAt)).limit(201);
      const history = recent
        .reverse()
        .filter((m) => m.id !== handle.userMessageId && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, artifacts: m.artifacts ?? [] }));
      const messages = await buildFolaxMessages({
        system: conv.systemPrompt ? `${profile.system}\n\n${conv.systemPrompt}` : profile.system,
        history,
        current: req.content,
        preamble: req.preamble,
        store: this.d.store,
        userId: req.userId,
      });

      const stream = await folax.chat({ model: res.model.slice(FOLAX_MODEL_PREFIX.length), messages, signal: AbortSignal.any([signal, interrupt.signal]) });
      // only once Folax accepted the turn: a refused one (busy, down, bad input) leaves the Qoder session as it was
      await this.detachQoderSession(st);
      emit({ type: 'turn.started', conversationId: conv.id, messageId: handle.messageId, model: st.model });
      for await (const delta of stream) {
        text += delta;
        emit({ type: 'text.delta', text: delta });
      }
      if (signal.aborted) throw new AppError(504, 'turn_timeout', 'The turn took too long and was stopped');
      return interrupt.signal.aborted ? 'interrupted' : 'end_turn';
    } catch (err) {
      if (interrupt.signal.aborted && !signal.aborted) return 'interrupted';
      throw err;
    } finally {
      this.folaxAborts.delete(conv.id);
      // partial text (interrupt, broken stream) is kept like a Qoder turn's
      if (text) {
        st.texts.push(text);
        emit({ type: 'text.completed', text });
      }
    }
  }

  /**
   * A conversation switching from a Qoder model to a Folax one: its Qoder session will miss the Folax turns, so it is
   * archived now. The next Qoder turn then starts a new session with the whole history as a transcript (the
   * existing "session lost" path). Cumulative-usage bookkeeping of the old session is reset with it.
   */
  private async detachQoderSession(st: RunState) {
    const sid = st.conv.qoderSessionId;
    if (!sid) return;
    const { applied: _applied, usage: _usage, ...metadata } = st.conv.metadata ?? {};
    await this.d.db.update(conversations).set({ qoderSessionId: null, lastEventId: null, metadata }).where(eq(conversations.id, st.conv.id));
    st.conv = { ...st.conv, qoderSessionId: null, lastEventId: null, metadata };
    st.lastEventId = null;
    void this.d.qoder.archiveSession(sid).catch((err) => this.d.log.warn('turn.session_release_failed', { conversationId: st.conv.id, err }));
  }

  /**
   * Detach and archive the conversation's Qoder session (one-shot turns, deleted conversations). Archiving also stops
   * a session that is still running, so nothing keeps working (or billing) for a result nobody will read. Never throws.
   */
  async releaseSession(conversationId: string): Promise<void> {
    try {
      const [row] = await this.d.db
        .select({ sid: conversations.qoderSessionId })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const sid = row?.sid;
      if (!sid) return;
      await this.d.db.update(conversations).set({ qoderSessionId: null, lastEventId: null }).where(eq(conversations.id, conversationId));
      await this.d.qoder.archiveSession(sid);
      this.d.log.debug('turn.session_released', { conversationId, sessionId: sid });
    } catch (err) {
      if (err instanceof AppError && err.code === 'upstream_not_found') return;
      this.d.log.warn('turn.session_release_failed', { conversationId, err });
    }
  }

  /**
   * Make sure the conversation has a Qoder session configured with the resolved model, system prompt and tools.
   * Retired models are detected here (400 from the patch) and replaced via the registry fallback chain.
   */
  /**
   * Mount an uploaded attachment into the session. Our cached Qoder file id can be stale (deleted upstream, or
   * uploaded under a previous PAT/account): on 404 the file is uploaded again and mounted with the new id.
   */
  private async mount(sessionId: string, m: { fileId: string; qoderFileId: string; mountPath: string }, userId: string) {
    try {
      await this.d.qoder.addFileResource(sessionId, m.qoderFileId, m.mountPath);
    } catch (err) {
      if (!isUpstreamNotFound(err)) return ignoreDuplicateMount(err);
      this.d.log.warn('turn.attachment_reupload', { fileId: m.fileId, staleQoderFileId: m.qoderFileId });
      m.qoderFileId = await reupload(m.fileId, userId, this.d.store, this.d.qoder);
      await this.d.qoder.addFileResource(sessionId, m.qoderFileId, m.mountPath).catch(ignoreDuplicateMount);
    }
  }

  private async ensureSession(st: RunState, needsDocTools: boolean, emit: (e: TurnEvent) => void): Promise<{ recreated: boolean }> {
    const conv = st.conv;
    const profile = PROFILES[conv.profile as ProfileName] ?? PROFILES.chat;
    const desiredSystem = conv.systemPrompt ? `${profile.system}\n\n${conv.systemPrompt}` : profile.system;
    const metaApplied = conv.metadata?.applied as AppliedConfig | undefined;
    let recreated = false;

    let sessionId = conv.qoderSessionId;
    let applied: AppliedConfig = metaApplied ?? { model: conv.resolvedModel ?? AGENT_BASE_MODEL, system: profile.system, tools: profile.tools };
    if (sessionId) {
      try {
        const s = await this.d.qoder.getSession(sessionId);
        // archived (e.g. by housekeeping) → terminated; it cannot take new messages
        if (s.archived_at || s.status === 'terminated') throw new AppError(404, 'upstream_not_found', 'Session archived');
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'upstream_not_found')) throw err;
        this.d.log.warn('turn.session_lost', { conversationId: conv.id, sessionId });
        sessionId = null;
      }
    }
    if (!sessionId) {
      sessionId = await this.createSession(profile.name, conv);
      applied = { model: AGENT_BASE_MODEL, system: profile.system, tools: profile.tools };
      recreated = !!conv.qoderSessionId || (await this.hasHistory(conv.id, st.handle.userMessageId));
      st.lastEventId = null;
    }
    st.sessionId = sessionId;

    // Tools follow the conversation's profile; a document upgrade, once applied, sticks so tools don't flap per turn.
    const docUpgraded = DOCUMENT_TOOLS.every((t) => applied.tools.includes(t)) && !DOCUMENT_TOOLS.every((t) => profile.tools.includes(t));
    const tools = needsDocTools || docUpgraded ? union(profile.tools, DOCUMENT_TOOLS) : profile.tools;
    for (let i = 0; ; i++) {
      const res = this.d.models.resolve(conv.model);
      if (res.fallbackReason) emit({ type: 'model.fallback', requested: res.requested, resolved: res.model, reason: res.fallbackReason });
      const patch: { model?: string; system?: string; tools?: { type: 'agent_toolset_20260401'; enabled_tools: string[] }[] } = {};
      if (applied.model !== res.model) patch.model = res.model;
      if (applied.system !== desiredSystem) patch.system = desiredSystem;
      if (!sameSet(applied.tools, tools)) patch.tools = tools.length ? [{ type: 'agent_toolset_20260401', enabled_tools: tools }] : [];
      try {
        if (Object.keys(patch).length) await this.d.qoder.updateSession(sessionId, { agent: patch });
        applied = { model: res.model, system: desiredSystem, tools };
        st.model = res.model;
        break;
      } catch (err) {
        if (!isModelUnavailable(err) || i >= MAX_MODEL_RETRIES) throw err;
        await this.d.models.markUnavailable(res.model);
      }
    }

    const [row] = await this.d.db
      .update(conversations)
      .set({ qoderSessionId: sessionId, resolvedModel: applied.model, lastEventId: st.lastEventId, metadata: { ...conv.metadata, applied } })
      .where(eq(conversations.id, conv.id))
      .returning();
    st.conv = row!;
    return { recreated };
  }

  private async createSession(profile: ProfileName, conv: ConversationRow): Promise<string> {
    const body = async () => ({
      agent: await this.d.agents.agentId(profile),
      environment_id: await this.d.agents.environmentId(),
      title: conv.title ?? undefined,
      metadata: { conversation_id: conv.id },
      ...(this.d.sessionBudgetCredits ? { budget: { type: 'limit' as const, max_credit_cost: this.d.sessionBudgetCredits.toFixed(2) } } : {}),
    });
    try {
      return (await this.d.qoder.createSession(await body())).id;
    } catch (err) {
      // the cached environment or agent may have been deleted upstream (or belong to another account) → re-resolve once
      if (!(err instanceof AppError && (err.code === 'upstream_not_found' || err.status === 400))) throw err;
      if (/environment/i.test(err.message)) {
        if (!(await this.d.agents.invalidateEnvironment())) throw err;
      } else await this.d.agents.invalidate(profile);
      return (await this.d.qoder.createSession(await body())).id;
    }
  }

  /** Open stream (before sending, so nothing is missed), send the message, map events until idle. */
  private async pump(st: RunState, content: QoderContentBlock[], emit: (e: TurnEvent) => void, signal: AbortSignal): Promise<StopReason> {
    let sent = false;
    for (let reconnect = 0; ; reconnect++) {
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const frames = await this.d.qoder.openEventStream(st.sessionId, { lastEventId: st.lastEventId, deltas: true, signal: ctrl.signal });
        if (!sent) {
          await this.d.qoder.sendEvents(st.sessionId, [{ type: 'user.message', content }]);
          sent = true;
        }
        for await (const frame of frames) {
          const stop = this.handleFrame(st, frame, emit);
          if (stop) return stop;
        }
      } catch (err) {
        if (signal.aborted) throw err;
        if (!sent || reconnect >= MAX_STREAM_RECONNECTS) throw err;
        this.d.log.warn('turn.stream_error', { conversationId: st.conv.id, err: (err as Error).message, reconnect });
      } finally {
        signal.removeEventListener('abort', abort);
        ctrl.abort();
      }
      if (reconnect >= MAX_STREAM_RECONNECTS) throw new AppError(502, 'upstream_unavailable', 'Lost the Qoder event stream');
      await new Promise((r) => setTimeout(r, 500 * (reconnect + 1)));
    }
  }

  /** Map one upstream frame to TurnEvents. Returns a stop reason when the turn is over. */
  private handleFrame(st: RunState, f: QoderStreamFrame, emit: (e: TurnEvent) => void): StopReason | undefined {
    const ev = f.data;
    if (f.event === 'event_start') {
      const started = ev.event as { id?: string; type?: string } | undefined;
      if (started?.type === 'agent.thinking' && started.id) {
        st.thinkingIds.add(started.id);
        emit({ type: 'thinking' });
      }
      return;
    }
    if (f.event === 'event_delta') {
      const text = (ev.delta as { content?: { text?: string } } | undefined)?.content?.text;
      if (text) {
        const id = String(ev.event_id ?? f.id);
        // a later agent.message in the same turn: separate it like the final joined text does
        const sep = !st.deltaIds.has(id) && st.texts.length ? '\n\n' : '';
        st.deltaIds.add(id);
        emit({ type: 'text.delta', text: sep + text });
      }
      return;
    }

    if (ev.id) st.lastEventId = ev.id;
    switch (ev.type) {
      case 'agent.thinking':
        if (!st.thinkingIds.has(ev.id ?? '')) emit({ type: 'thinking' });
        return;
      case 'agent.message': {
        const text = textOf(ev.content);
        if (!text) return;
        if (!st.deltaIds.has(ev.id ?? '')) emit({ type: 'text.delta', text: st.texts.length ? `\n\n${text}` : text });
        st.texts.push(text);
        emit({ type: 'text.completed', text });
        return;
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
        emit({ type: 'tool.started', id: ev.id ?? '', name: String(ev.name ?? 'tool'), input: ev.input ?? null });
        this.saveCursor(st);
        return;
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        emit({ type: 'tool.completed', id: String(ev.tool_use_id ?? ''), isError: !!ev.is_error, output: textOf(ev.content).slice(0, 4000) });
        return;
      case 'agent.artifact_delivered':
        st.pending.push(this.saveArtifact(st, ev, emit));
        this.saveCursor(st);
        return;
      case 'session.usage':
        st.usage = {
          model: Number(ev.model_credits ?? 0),
          sandbox: Number(ev.sandbox_runtime_credits ?? 0),
          total: Number(ev.total_credits ?? 0),
        };
        return;
      case 'session.error': {
        const e = (ev.error ?? {}) as { type?: string; message?: string };
        const message = e.message ?? 'Upstream session error';
        if (/must reference an available model/i.test(message)) st.modelUnavailable = true;
        else st.error = { code: e.type ?? 'upstream_error', message: `Qoder: ${message}` };
        return;
      }
      case 'session.status_idle': {
        const reason = (ev.stop_reason as { type?: string } | undefined)?.type ?? 'end_turn';
        if (st.error && !st.modelUnavailable) emit({ type: 'error', code: st.error.code, message: st.error.message, retryable: true });
        return st.error && !st.modelUnavailable ? 'error' : normalizeStop(reason);
      }
      case 'session.status_terminated':
        st.error ??= { code: 'upstream_terminated', message: 'Qoder terminated the session' };
        emit({ type: 'error', code: st.error.code, message: st.error.message, retryable: false });
        return 'error';
      default:
        return;
    }
  }

  private async saveArtifact(st: RunState, ev: QoderEvent, emit: (e: TurnEvent) => void) {
    const qoderFileId = String(ev.file_id);
    try {
      const bytes = await this.d.qoder.downloadFile(qoderFileId);
      const file = await this.d.store.save({
        userId: st.req.userId,
        kind: 'artifact',
        filename: String(ev.original_filename ?? qoderFileId),
        mimeType: String(ev.content_type ?? 'application/octet-stream'),
        bytes,
        conversationId: st.conv.id,
        jobId: st.req.jobId ?? null,
        qoderFileId,
      });
      const artifact = this.d.store.toArtifact(file);
      st.artifacts.push(artifact);
      emit({ type: 'artifact', artifact });
    } catch (err) {
      this.d.log.error('turn.artifact_failed', { conversationId: st.conv.id, qoderFileId, err });
      emit({ type: 'error', code: 'artifact_download_failed', message: `Could not fetch generated file ${ev.original_filename ?? ''}`, retryable: true });
    }
  }

  /** Persist the stream cursor at tool boundaries so a crash mid-turn can resume close to where it was. */
  private saveCursor(st: RunState) {
    void this.d.db.update(conversations).set({ lastEventId: st.lastEventId }).where(eq(conversations.id, st.conv.id)).catch(() => {});
  }

  /** session.usage is cumulative per session → per-turn credits are the difference to the last snapshot. */
  private async creditsDelta(st: RunState): Promise<Credits> {
    if (!st.usage) return zeroCredits();
    const prev = (st.conv.metadata?.usage as Credits | undefined) ?? zeroCredits();
    const delta = {
      model: round(Math.max(0, st.usage.model - prev.model)),
      sandbox: round(Math.max(0, st.usage.sandbox - prev.sandbox)),
      total: round(Math.max(0, st.usage.total - prev.total)),
    };
    st.conv = { ...st.conv, metadata: { ...st.conv.metadata, usage: st.usage } };
    return delta;
  }

  private async persist(st: RunState, r: TurnResult) {
    const artifacts: ArtifactRef[] = r.artifacts.map((a) => ({ fileId: a.id, name: a.name, mimeType: a.mimeType, size: a.size, kind: a.kind }));
    await this.d.conversations.addMessage({
      id: r.messageId,
      conversationId: st.conv.id,
      role: 'assistant',
      content: r.text ? [{ type: 'text', text: r.text }] : [],
      artifacts,
      model: r.model || null,
      credits: r.credits.total,
      stopReason: r.stopReason,
      error: r.error ?? null,
    });
    const firstText = st.req.content.find((b) => b.type === 'text');
    await this.d.db
      .update(conversations)
      .set({
        lastEventId: st.lastEventId,
        updatedAt: new Date(),
        metadata: st.conv.metadata,
        // placeholder title from the first message; coalesce so it never overwrites one set meanwhile (auto titler, user rename)
        ...(st.conv.title || !firstText ? {} : { title: sql`coalesce(${conversations.title}, ${firstText.text.replace(/\s+/g, ' ').trim().slice(0, 80)})` }),
      })
      .where(eq(conversations.id, st.conv.id));
  }

  private async hasHistory(conversationId: string, excludeMessageId: string) {
    const msgs = await this.d.conversations.messages(conversationId, { limit: 2 });
    return msgs.some((m) => m.id !== excludeMessageId);
  }

  /** Rebuild context from our own DB when the upstream session was lost. */
  private async historyPreamble(conversationId: string, excludeMessageId: string): Promise<string | undefined> {
    // the newest 200 messages, oldest first (a model switch Folax → Qoder rebuilds the context through here too)
    const recent = await this.d.db.select().from(messageRows).where(eq(messageRows.conversationId, conversationId)).orderBy(desc(messageRows.createdAt)).limit(201);
    const msgs = recent.reverse().filter((m) => m.id !== excludeMessageId);
    if (!msgs.length) return undefined;
    const lines = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')}`);
    return `Conversation so far (for context — continue from it):\n\n${lines.join('\n\n')}\n\n---\nNew message from the user:`;
  }

  private async lock(conversationId: string) {
    const staleBefore = new Date(Date.now() - STALE_BUSY_MS);
    const rows = await this.d.db
      .update(conversations)
      .set({ status: 'busy', busySince: new Date() })
      .where(and(eq(conversations.id, conversationId), or(eq(conversations.status, 'idle'), lt(conversations.busySince, staleBefore))))
      .returning({ id: conversations.id });
    if (!rows.length) throw conflict('This conversation is already generating a reply', 'conversation_busy');
  }

  private async unlock(conversationId: string) {
    await this.d.db.update(conversations).set({ status: 'idle', busySince: null }).where(eq(conversations.id, conversationId));
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === 'text' || typeof c?.text === 'string' ? (c.text ?? '') : ''))
    .join('');
}

function normalizeStop(reason: string): StopReason {
  if (reason === 'interrupted' || reason === 'requires_action' || reason === 'budget_exceeded') return reason;
  return 'end_turn';
}

const isUpstreamNotFound = (err: unknown) => err instanceof AppError && err.code === 'upstream_not_found';

const ignoreDuplicateMount = (err: unknown) => {
  if (err instanceof AppError && err.status === 409) return;
  throw err;
};

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const round = (n: number) => Math.round(n * 10000) / 10000;
