import type { Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { estimateTokens } from '../../core/compat.js';
import type { StopReason, TurnEvent } from '../../core/events.js';
import { badRequest } from '../../errors.js';
import { type Env, jsonBody } from '../../http.js';
import {
  contentWithArtifacts,
  type InputMessage,
  type InputPart,
  joinSystem,
  jsonInstruction,
  parseBody,
  toolsNotSupported,
} from './input.js';
import { folaxToolsProxy, isFolaxToolsRequest } from './folaxTools.js';
import { beginTurn, completeTurn, nowSec, publicModelId, type StartedTurn, streamTurn, type Write } from './turn.js';

const TextPart = z.object({ type: z.literal('text'), text: z.string() });
const ContentPart = z.discriminatedUnion('type', [
  TextPart,
  z.object({ type: z.literal('refusal'), refusal: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.union([z.string(), z.object({ url: z.string().min(1), detail: z.string().optional() })]),
  }),
  z.object({
    type: z.literal('file'),
    file: z.object({ file_data: z.string().optional(), filename: z.string().optional(), file_id: z.string().optional() }),
  }),
]);
const Content = z.union([z.string(), z.array(ContentPart)]).nullish();

const Message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: Content,
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
});
type Message = z.infer<typeof Message>;

const ChatRequest = z.object({
  model: z.string().optional(),
  messages: z.array(Message).min(1),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).nullish(),
  n: z.number().int().nullish(),
  tools: z.array(z.unknown()).nullish(),
  functions: z.array(z.unknown()).nullish(),
  tool_choice: z.unknown().optional(),
  response_format: z
    .object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      json_schema: z.object({ name: z.string().optional(), schema: z.unknown().optional() }).optional(),
    })
    .nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
type ChatRequest = z.infer<typeof ChatRequest>;

/** POST /chat/completions */
export function chatCompletions(ctx: AppContext) {
  return async (c: Context<Env>) => {
    const raw = await jsonBody(c);
    // Folax models with tools (coding agents): proxied to the adapter, see folaxTools.ts. Everything else is unchanged.
    if (isFolaxToolsRequest(raw)) return folaxToolsProxy(ctx, c, raw);
    const req = parseBody(ChatRequest, raw);
    rejectUnsupported(req);

    const system = joinSystem([
      ...req.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => partsOf(m).map(textOf).join('\n')),
      jsonInstruction(req.response_format ? { type: req.response_format.type, ...req.response_format.json_schema } : undefined),
    ]);
    const dialogue = req.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(toInput);
    const last = dialogue.pop();
    if (!last || last.role !== 'user' || req.messages.at(-1)?.role !== 'user') {
      throw badRequest('The last message must have role "user"', 'invalid_request', { param: 'messages' });
    }

    const turn = await beginTurn(c, ctx, {
      model: req.model,
      system,
      history: dialogue,
      last,
      conversationId: req.metadata?.conversation_id,
    });
    const id = `chatcmpl-${turn.handle.messageId}`;
    if (req.stream) return streamTurn(c, turn, chunkRenderer(id, turn, !!req.stream_options?.include_usage));

    const result = await completeTurn(c, turn);
    const content = contentWithArtifacts(result.text, result.artifacts);
    return c.json({
      id,
      object: 'chat.completion',
      created: nowSec(),
      model: publicModelId(result.model),
      system_fingerprint: null,
      choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, logprobs: null, finish_reason: finishReason(result.stopReason) }],
      usage: usage(turn.promptTokens, content, result.credits.total),
      stillgpt: { conversation_id: turn.conversationId, credits: result.credits },
    });
  };
}

function rejectUnsupported(req: ChatRequest) {
  if ((req.n ?? 1) !== 1) throw badRequest('Only n=1 is supported', 'invalid_request', { param: 'n' });
  const declaresTools = !!(req.tools?.length || req.functions?.length);
  const usesTools = req.messages.some((m) => m.role === 'tool' || m.role === 'function' || m.tool_calls?.length || m.function_call);
  if (usesTools || (declaresTools && req.tool_choice !== 'none')) throw toolsNotSupported();
}

function partsOf(m: Message): z.infer<typeof ContentPart>[] {
  if (m.content == null) return [];
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

const textOf = (p: z.infer<typeof ContentPart>) => (p.type === 'text' ? p.text : p.type === 'refusal' ? p.refusal : '');

function toInput(m: Message): InputMessage {
  const parts = partsOf(m).map((p): InputPart => {
    switch (p.type) {
      case 'text':
        return { kind: 'text', text: p.text };
      case 'refusal':
        return { kind: 'text', text: p.refusal };
      case 'image_url':
        return { kind: 'image', url: typeof p.image_url === 'string' ? p.image_url : p.image_url.url };
      case 'file':
        if (!p.file.file_data) throw badRequest('Only inline files are supported: set file.file_data (data URL or base64)', 'invalid_request', { param: 'file.file_data' });
        return { kind: 'file', data: p.file.file_data, filename: p.file.filename };
    }
  });
  return { role: m.role as 'user' | 'assistant', parts };
}

const finishReason = (s: StopReason) => (s === 'budget_exceeded' ? 'length' : 'stop');

function usage(promptTokens: number, completion: string, credits: number) {
  const completionTokens = completion ? estimateTokens(completion) : 0;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, stillgpt_credits: credits };
}

/** Maps TurnEvents to `chat.completion.chunk` SSE frames. */
function chunkRenderer(id: string, turn: StartedTurn, includeUsage: boolean) {
  const created = nowSec();
  let started = false;
  let emitted = '';

  return async (e: TurnEvent, write: Write, model: string): Promise<boolean> => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      write({ id, object: 'chat.completion.chunk', created, model: publicModelId(model), system_fingerprint: null, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    if (!started) {
      started = true;
      await chunk({ role: 'assistant', content: '' });
    }

    switch (e.type) {
      case 'text.delta':
        emitted += e.text;
        await chunk({ content: e.text });
        return false;
      case 'error':
        await write({ error: { message: e.message, type: 'server_error', code: e.code, param: null } });
        await write('[DONE]');
        return true;
      case 'turn.completed': {
        if (e.stopReason === 'error') {
          await write({ error: { message: 'The turn failed', type: 'server_error', code: 'upstream_error', param: null } });
          await write('[DONE]');
          return true;
        }
        const tail = contentWithArtifacts(e.text, e.artifacts).slice(e.text.length);
        if (tail) {
          emitted += tail;
          await chunk({ content: tail });
        }
        await chunk({}, finishReason(e.stopReason));
        if (includeUsage) {
          await write({ id, object: 'chat.completion.chunk', created, model: publicModelId(model), system_fingerprint: null, choices: [], usage: usage(turn.promptTokens, emitted, e.credits.total) });
        }
        await write('[DONE]');
        return true;
      }
      default:
        return false;
    }
  };
}
