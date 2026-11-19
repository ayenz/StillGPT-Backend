import type { Context } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import type { AppContext } from '../../context.js';
import { compatHeaders, estimateTokens, startCompatTurn } from '../../core/compat.js';
import { isFolaxModelId } from '../../core/folaxChat.js';
import type { TurnEvent } from '../../core/events.js';
import type { ProfileName } from '../../core/profiles.js';
import type { TurnHandle, TurnResult } from '../../core/turns.js';
import { AppError, badRequest, turnErrorStatus } from '../../errors.js';
import type { Env } from '../../http.js';
import { type InputMessage, ingestMessage, messageText, toCompatMessage } from './input.js';

const HEARTBEAT_MS = 15_000;
const COMPAT_PROFILES: readonly ProfileName[] = ['chat', 'assistant'];

export interface TurnInput {
  model: string | undefined;
  system: string | null;
  /** Everything before the final user message. */
  history: InputMessage[];
  last: InputMessage;
  /** `metadata.conversation_id` from the body (the header wins). */
  conversationId?: string;
}

export interface StartedTurn {
  handle: TurnHandle;
  conversationId: string;
  /** Rough prompt token count (Qoder exposes none). */
  promptTokens: number;
}

/** `qoder/<id>` for Qoder models; Folax chat models already carry their namespace (`folax/<id>`). */
export const publicModelId = (id: string) => (isFolaxModelId(id) ? id : `qoder/${id}`);

function profileOf(c: Context<Env>, ctx: AppContext): ProfileName {
  const header = c.req.header('x-stillgpt-profile')?.trim().toLowerCase();
  if (!header) return ctx.config.DEFAULT_PROFILE_COMPAT;
  if (!COMPAT_PROFILES.includes(header as ProfileName)) {
    throw badRequest(`X-StillGPT-Profile must be one of: ${COMPAT_PROFILES.join(', ')}`, 'invalid_profile');
  }
  return header as ProfileName;
}

/** Validates model/profile, ingests the final message and starts the turn on the matching conversation. */
export async function beginTurn(c: Context<Env>, ctx: AppContext, input: TurnInput): Promise<StartedTurn> {
  const user = c.get('user');
  const model = input.model?.trim() || 'default';
  ctx.models.resolve(model); // fail fast on media models / no models at all
  const profile = profileOf(c, ctx);
  const content = await ingestMessage(ctx, user.id, input.last);

  const { conversation, handle } = await startCompatTurn(ctx, {
    user,
    source: 'openai',
    model,
    profile,
    system: input.system,
    history: input.history.map(toCompatMessage),
    last: content,
    lastCompat: toCompatMessage(input.last),
    conversationId: c.req.header('x-stillgpt-conversation')?.trim() || input.conversationId || null,
  });

  const promptText = [input.system ?? '', ...input.history.map(messageText), messageText(input.last)].join('\n');
  return { handle, conversationId: conversation.id, promptTokens: estimateTokens(promptText) };
}

/** Awaits the whole turn; a failed turn becomes a 502 (the global handler renders the OpenAI envelope). */
export async function completeTurn(c: Context<Env>, turn: StartedTurn): Promise<TurnResult> {
  const result = await turn.handle.done;
  if (result.stopReason === 'error') {
    throw new AppError(turnErrorStatus(result.error?.code), result.error?.code ?? 'upstream_error', result.error?.message ?? 'The turn failed');
  }
  for (const [k, v] of Object.entries(compatHeaders(turn.conversationId, result.model, result.credits.total))) c.header(k, v);
  return result;
}

export type Write = (data: unknown, event?: string) => Promise<void>;

/**
 * Streams a turn as SSE. Waits for `turn.started` first so the resolved model is known and errors that happen
 * before the agent starts still produce a normal JSON error response.
 * `render` maps each TurnEvent to SSE writes and returns true when the stream is complete.
 * The turn keeps running if the client disconnects; we only stop writing.
 */
export async function streamTurn(
  c: Context<Env>,
  turn: StartedTurn,
  render: (e: TurnEvent, write: Write, model: string) => Promise<boolean>,
): Promise<Response> {
  const abort = new AbortController();
  const events = turn.handle.iterate(abort.signal);
  const model = await awaitStart(events);

  for (const [k, v] of Object.entries(compatHeaders(turn.conversationId, model))) c.header(k, v);
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => abort.abort());
    const heartbeat = setInterval(() => void stream.write(': keepalive\n\n').catch(() => abort.abort()), HEARTBEAT_MS);
    const write: Write = async (data, event) => {
      if (abort.signal.aborted) return;
      await stream.writeSSE({ data: typeof data === 'string' ? data : JSON.stringify(data), ...(event ? { event } : {}) });
    };
    try {
      for await (const e of events) {
        if (await render(e, write, model)) break;
      }
    } catch (err) {
      await writeStreamError(stream, err);
    } finally {
      clearInterval(heartbeat);
      abort.abort();
    }
  });
}

/** Consumes events up to `turn.started` and returns the resolved model id; turn failures before that throw. */
async function awaitStart(events: AsyncGenerator<TurnEvent>): Promise<string> {
  for await (const e of peekable(events)) {
    if (e.type === 'turn.started') return e.model;
    if (e.type === 'error') throw new AppError(turnErrorStatus(e.code), e.code, e.message);
    if (e.type === 'turn.completed') break;
  }
  throw new AppError(502, 'upstream_error', 'The turn ended before it started');
}

/** Iterate a generator without closing it when the loop exits early (so the caller can keep consuming it). */
function peekable<T>(it: AsyncGenerator<T>): AsyncIterable<T> {
  return { [Symbol.asyncIterator]: () => ({ next: () => it.next() }) };
}

async function writeStreamError(stream: SSEStreamingApi, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await stream.writeSSE({ data: JSON.stringify({ error: { message, type: 'server_error', code: 'stream_error', param: null } }) }).catch(() => {});
}

export const nowSec = () => Math.floor(Date.now() / 1000);
