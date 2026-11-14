import type { Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { estimateTokens } from '../../core/compat.js';
import type { StopReason, TurnEvent } from '../../core/events.js';
import type { TurnResult } from '../../core/turns.js';
import { badRequest } from '../../errors.js';
import { type Env, jsonBody } from '../../http.js';
import { contentWithArtifacts, type InputMessage, type InputPart, joinSystem, jsonInstruction, parseBody, toolsNotSupported } from './input.js';
import { beginTurn, completeTurn, nowSec, publicModelId, type StartedTurn, streamTurn, type Write } from './turn.js';

const Part = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text: z.string() }),
  z.object({ type: z.literal('output_text'), text: z.string() }),
  z.object({ type: z.literal('refusal'), refusal: z.string() }),
  z.object({ type: z.literal('input_image'), image_url: z.string().nullish(), file_id: z.string().nullish() }),
  z.object({ type: z.literal('input_file'), file_data: z.string().nullish(), filename: z.string().nullish(), file_id: z.string().nullish(), file_url: z.string().nullish() }),
]);
type Part = z.infer<typeof Part>;

const MessageItem = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(Part)]),
});
type MessageItem = z.infer<typeof MessageItem>;

const Item = z.union([MessageItem, z.object({ type: z.string() }).loose()]);

const ResponsesRequest = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(Item)]),
  instructions: z.string().nullish(),
  stream: z.boolean().nullish(),
  tools: z.array(z.unknown()).nullish(),
  tool_choice: z.unknown().optional(),
  previous_response_id: z.string().nullish(),
  text: z.object({ format: z.object({ type: z.string(), name: z.string().optional(), schema: z.unknown().optional() }).optional() }).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
type ResponsesRequest = z.infer<typeof ResponsesRequest>;

/** POST /responses — minimal Responses API: message input only, no tools, no stored responses. */
export function responses(ctx: AppContext) {
  return async (c: Context<Env>) => {
    const req = parseBody(ResponsesRequest, await jsonBody(c));
    if (req.tools?.length && req.tool_choice !== 'none') throw toolsNotSupported();
    if (req.previous_response_id) {
      throw badRequest('previous_response_id is not supported; send the full input (or use X-StillGPT-Conversation)', 'invalid_request', { param: 'previous_response_id' });
    }

    const items = typeof req.input === 'string' ? [{ role: 'user' as const, content: req.input }] : req.input.map(asMessage);
    const system = joinSystem([
      req.instructions,
      ...items.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => partsOf(m).map(textOf).join('\n')),
      jsonInstruction(req.text?.format),
    ]);
    const dialogue = items.filter((m) => m.role === 'user' || m.role === 'assistant').map(toInput);
    const last = dialogue.pop();
    if (!last || last.role !== 'user') throw badRequest('The last input message must have role "user"', 'invalid_request', { param: 'input' });

    const turn = await beginTurn(c, ctx, { model: req.model, system, history: dialogue, last, conversationId: req.metadata?.conversation_id });
    const ids = { response: `resp_${turn.handle.messageId}`, item: `msg_${turn.handle.messageId}` };
    const shell = { req, ids, turn };
    if (req.stream) return streamTurn(c, turn, eventRenderer(shell));

    const result = await completeTurn(c, turn);
    return c.json(responseObject(shell, publicModelId(result.model), finalState(result)));
  };
}

function asMessage(item: z.infer<typeof Item>): MessageItem {
  const parsed = MessageItem.safeParse(item);
  if (parsed.success) return parsed.data;
  if (/function_call|tool/.test(item.type ?? '')) throw toolsNotSupported();
  throw badRequest(`Input items of type '${item.type}' are not supported`, 'invalid_request', { param: 'input' });
}

const partsOf = (m: MessageItem): Part[] => (typeof m.content === 'string' ? [{ type: 'input_text', text: m.content }] : m.content);
const textOf = (p: Part) => (p.type === 'input_text' || p.type === 'output_text' ? p.text : p.type === 'refusal' ? p.refusal : '');

function toInput(m: MessageItem): InputMessage {
  const parts = partsOf(m).map((p): InputPart => {
    switch (p.type) {
      case 'input_text':
      case 'output_text':
        return { kind: 'text', text: p.text };
      case 'refusal':
        return { kind: 'text', text: p.refusal };
      case 'input_image':
        if (!p.image_url) throw badRequest('input_image needs image_url (data URL or https URL)', 'invalid_request', { param: 'image_url' });
        return { kind: 'image', url: p.image_url };
      case 'input_file':
        if (p.file_data) return { kind: 'file', data: p.file_data, filename: p.filename ?? undefined };
        if (p.file_url) return { kind: 'image', url: p.file_url }; // URL parts are stored by their content type (image or document)
        throw badRequest('input_file needs file_data or file_url', 'invalid_request', { param: 'file_data' });
    }
  });
  return { role: m.role as 'user' | 'assistant', parts };
}

interface Shell {
  req: ResponsesRequest;
  ids: { response: string; item: string };
  turn: StartedTurn;
}

interface FinalState {
  text: string;
  stopReason: StopReason;
  credits: number;
}

const finalState = (r: Pick<TurnResult, 'text' | 'artifacts' | 'stopReason'> & { credits: { total: number } }): FinalState => ({
  text: contentWithArtifacts(r.text, r.artifacts),
  stopReason: r.stopReason,
  credits: r.credits.total,
});

const outputPart = (text: string) => ({ type: 'output_text', text, annotations: [] as unknown[] });

function messageItem(s: Shell, text: string | null) {
  return { id: s.ids.item, type: 'message', status: text === null ? 'in_progress' : 'completed', role: 'assistant', content: text === null ? [] : [outputPart(text)] };
}

/** The `response` object; `final` absent → in-progress snapshot (stream start). */
function responseObject(s: Shell, model: string, final?: FinalState, error?: { code: string; message: string }) {
  const outputTokens = final?.text ? estimateTokens(final.text) : 0;
  const status = error ? 'failed' : !final ? 'in_progress' : final.stopReason === 'budget_exceeded' ? 'incomplete' : 'completed';
  return {
    id: s.ids.response,
    object: 'response',
    created_at: nowSec(),
    status,
    error: error ?? null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: s.req.instructions ?? null,
    model,
    output: final ? [messageItem(s, final.text)] : [],
    output_text: final?.text ?? '',
    parallel_tool_calls: false,
    tool_choice: 'none',
    tools: [],
    metadata: s.req.metadata ?? {},
    usage: final
      ? {
          input_tokens: s.turn.promptTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: s.turn.promptTokens + outputTokens,
          stillgpt_credits: final.credits,
        }
      : null,
    stillgpt: { conversation_id: s.turn.conversationId },
  };
}

/** Maps TurnEvents to Responses API stream events (`event: <type>` + JSON data with sequence numbers). */
function eventRenderer(s: Shell) {
  let seq = 0;
  let started = false;
  let text = '';
  const loc = { item_id: s.ids.item, output_index: 0, content_index: 0 };

  return async (e: TurnEvent, write: Write, qoderModel: string): Promise<boolean> => {
    const model = publicModelId(qoderModel);
    const send = (type: string, fields: Record<string, unknown>) => write({ type, sequence_number: seq++, ...fields }, type);
    if (!started) {
      started = true;
      const snapshot = responseObject(s, model);
      await send('response.created', { response: snapshot });
      await send('response.in_progress', { response: snapshot });
      await send('response.output_item.added', { output_index: 0, item: messageItem(s, null) });
      await send('response.content_part.added', { ...loc, part: outputPart('') });
    }

    switch (e.type) {
      case 'text.delta':
        text += e.text;
        await send('response.output_text.delta', { ...loc, delta: e.text, logprobs: [] });
        return false;
      case 'error':
        await send('response.failed', { response: responseObject(s, model, undefined, { code: e.code, message: e.message }) });
        return true;
      case 'turn.completed': {
        if (e.stopReason === 'error') {
          await send('response.failed', { response: responseObject(s, model, undefined, { code: 'upstream_error', message: 'The turn failed' }) });
          return true;
        }
        const final = finalState(e);
        const tail = final.text.slice(e.text.length);
        if (tail) await send('response.output_text.delta', { ...loc, delta: tail, logprobs: [] });
        text += tail;
        await send('response.output_text.done', { ...loc, text, logprobs: [] });
        await send('response.content_part.done', { ...loc, part: outputPart(text) });
        await send('response.output_item.done', { output_index: 0, item: messageItem(s, text) });
        await send(final.stopReason === 'budget_exceeded' ? 'response.incomplete' : 'response.completed', { response: responseObject(s, model, { ...final, text }) });
        return true;
      }
      default:
        return false;
    }
  };
}
