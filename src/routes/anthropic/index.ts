import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppContext } from '../../context.js';
import { type CompatTurn, compatHeaders, estimateTokens, startCompatTurn } from '../../core/compat.js';
import type { TurnEvent } from '../../core/events.js';
import { isFolaxModelId } from '../../core/folaxChat.js';
import type { ProfileName } from '../../core/profiles.js';
import { AppError, badRequest, turnErrorStatus } from '../../errors.js';
import { type Env, jsonBody, requireUser } from '../../http.js';
import { artifactMarkdown, assertNoTools, promptText, systemText, toAnthropicStop, toCompatMessage, toContentBlocks } from './convert.js';
import { countTokensRequest, type MessagesRequest, messagesRequest } from './schema.js';
import { anthropicSse } from './stream.js';

const COMPAT_PROFILES: ProfileName[] = ['chat', 'assistant'];

/**
 * Anthropic-compatible Messages API: POST /v1/messages, /v1/messages/count_tokens.
 * (GET /v1/models is served by the OpenAI router, which switches format on `anthropic-version`.)
 */
export function anthropicRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const auth = requireUser(ctx);
  app.use('/messages', auth);
  app.use('/messages/*', auth);

  const notSupported = () => {
    throw new AppError(501, 'not_supported', 'Message batches are not supported by StillGPT');
  };
  app.all('/messages/batches', notSupported);
  app.all('/messages/batches/*', notSupported);

  app.post('/messages/count_tokens', async (c) => {
    const req = parse(countTokensRequest, await jsonBody(c));
    return c.json({ input_tokens: estimateTokens(promptText(req)) });
  });

  app.post('/messages', async (c) => {
    const req = parse(messagesRequest, await jsonBody(c));
    assertNoTools(req);
    const turn = await startTurn(ctx, c, req);
    const inputTokens = estimateTokens(promptText(req));
    return req.stream ? streamReply(c, turn, inputTokens) : jsonReply(c, turn, inputTokens);
  });

  return app;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue?.message ?? 'Invalid request'}`, 'invalid_request');
}

function profileFrom(c: Context<Env>, fallback: ProfileName): ProfileName {
  const raw = c.req.header('x-stillgpt-profile')?.trim();
  if (!raw) return fallback;
  if (!COMPAT_PROFILES.includes(raw as ProfileName)) throw badRequest(`X-StillGPT-Profile must be one of: ${COMPAT_PROFILES.join(', ')}`, 'invalid_profile');
  return raw as ProfileName;
}

async function startTurn(ctx: AppContext, c: Context<Env>, req: MessagesRequest): Promise<CompatTurn> {
  const lastMessage = req.messages.at(-1)!;
  if (lastMessage.role !== 'user') throw badRequest('The final message must have role "user"', 'invalid_request');
  const user = c.get('user');
  return startCompatTurn(ctx, {
    user,
    source: 'anthropic',
    model: req.model,
    profile: profileFrom(c, ctx.config.DEFAULT_PROFILE_COMPAT),
    system: systemText(req.system),
    history: req.messages.slice(0, -1).map(toCompatMessage),
    last: await toContentBlocks(ctx, user.id, lastMessage),
    lastCompat: toCompatMessage(lastMessage),
    conversationId: c.req.header('x-stillgpt-conversation')?.trim() || req.metadata?.conversation_id || null,
  });
}

const publicModel = (id: string) => (isFolaxModelId(id) ? id : `qoder/${id}`);

async function jsonReply(c: Context<Env>, { conversation, handle }: CompatTurn, inputTokens: number) {
  const result = await handle.done;
  if (result.stopReason === 'error') {
    throw new AppError(turnErrorStatus(result.error?.code), result.error?.code ?? 'upstream_error', result.error?.message ?? 'The turn failed upstream');
  }
  const model = publicModel(result.model);
  const text = result.text + result.artifacts.map(artifactMarkdown).join('');
  return c.json(
    {
      id: result.messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: toAnthropicStop(result.stopReason),
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(result.text), stillgpt_credits: result.credits.total },
    },
    200,
    compatHeaders(conversation.id, model, result.credits.total),
  );
}

/** Pulls events until the turn has resolved its model (needed for headers and `message_start`). */
async function awaitStart(events: AsyncIterator<TurnEvent>): Promise<string> {
  for (;;) {
    const { value: e, done } = await events.next();
    if (done) throw new AppError(502, 'upstream_error', 'The turn ended before it started');
    if (e.type === 'turn.started') return e.model;
    if (e.type === 'error') throw new AppError(turnErrorStatus(e.code), e.code, e.message);
    if (e.type === 'turn.completed') throw new AppError(502, 'upstream_error', 'The turn failed before it started');
  }
}

async function streamReply(c: Context<Env>, { conversation, handle }: CompatTurn, inputTokens: number) {
  const disconnect = new AbortController();
  const events = handle.iterate(disconnect.signal);
  const model = publicModel(await awaitStart(events));
  const body = anthropicSse({
    events: { [Symbol.asyncIterator]: () => events },
    messageId: handle.messageId,
    model,
    inputTokens,
    onDisconnect: () => disconnect.abort(),
  });
  return c.body(body, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...compatHeaders(conversation.id, model),
  });
}
