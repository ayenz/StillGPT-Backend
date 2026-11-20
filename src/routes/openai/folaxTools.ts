import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../../context.js';
import { FOLAX_MODEL_PREFIX, isFolaxModelId } from '../../core/folaxChat.js';
import { zeroCredits } from '../../core/events.js';
import { AppError, badRequest } from '../../errors.js';
import type { Env } from '../../http.js';
import { parseSse } from '../../qoder/sse.js';

/**
 * Tool calling (function calling) on Folax chat models, for coding agents (OpenCode, Continue, Cline, …).
 *
 * The Folax adapter simulates OpenAI tool calling through the prompt and is stateless in this mode (the client sends the
 * whole history every step), so these requests are proxied to it as they are: no conversation is stored, the Qoder
 * and plain Folax chat paths are not involved, and Qoder models keep refusing `tools`. Each step is one free usage row.
 *
 * Applies to `folax/<model>` requests that carry `tools`, or whose history holds tool calls / tool results.
 */

const HEARTBEAT_MS = 15_000;
/** The adapter allows 120 s per Folax call and retries a malformed tool call once: up to ~240 s per step. */
const STEP_TIMEOUT_MS = 250_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Folax said this model handles tools unreliably (1 of 3 runs). */
const NO_TOOLS_MODELS = new Set(['metaai']);

type Json = Record<string, unknown>;

/** True when a `/chat/completions` body should go through the Folax tool-calling proxy. */
export function isFolaxToolsRequest(raw: unknown): raw is Json {
  if (!raw || typeof raw !== 'object') return false;
  const body = raw as Json;
  if (!isFolaxModelId(typeof body.model === 'string' ? body.model : '')) return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return Array.isArray(body.messages) && body.messages.some((m) => isToolMessage(m));
}

const isToolMessage = (m: unknown) => {
  const msg = (m ?? {}) as Json;
  return msg.role === 'tool' || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
};

/** POST /chat/completions for a Folax model with tools: validate, forward to the adapter, relay its answer. */
export async function folaxToolsProxy(ctx: AppContext, c: Context<Env>, body: Json): Promise<Response> {
  const user = c.get('user');
  const requested = String(body.model);
  const model = ctx.models.resolve(requested).model; // unknown → 400 model_not_found; unconfigured → 400 provider_unavailable
  const name = model.slice(FOLAX_MODEL_PREFIX.length);
  if (NO_TOOLS_MODELS.has(name))
    throw badRequest(`${model} is not reliable with tools; use folax/chatgpt or folax/gemini`, 'model_not_supported', { param: 'model' });
  if (body.functions !== undefined || body.function_call !== undefined)
    throw badRequest('Legacy `functions` are not supported; send `tools` instead', 'invalid_request', { param: 'functions' });
  if (!Array.isArray(body.messages) || !body.messages.length) throw badRequest('`messages` must be a non-empty array', 'invalid_request', { param: 'messages' });
  const folax = ctx.folax;
  if (!folax) throw new AppError(400, 'provider_unavailable', 'Folax models are not configured on this server', { param: 'model' });
  if (folax.knownDown()) throw new AppError(503, 'provider_unavailable', 'Folax is unavailable right now', { provider: 'folax' });
  await ctx.usage.assertWithinLimit(user.id);

  const stream = body.stream === true;
  const upstream = {
    model: name,
    messages: await Promise.all(body.messages.map((m) => toAdapterMessage(m))),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    stream,
  };
  const abort = new AbortController();
  const res = await folax.send('/v1/chat/completions', { json: upstream, timeoutMs: STEP_TIMEOUT_MS, signal: abort.signal });
  if (!res.ok) throw await folax.failure('/v1/chat/completions', res);
  const record = () =>
    ctx.usage.record({ userId: user.id, kind: 'chat', model, credits: zeroCredits(), free: true }).catch((err) => ctx.log.warn('folax.tools_usage_failed', { err }));
  c.header('X-StillGPT-Model', model);

  if (!stream) {
    const answer = (await res.json()) as Json;
    answer.model = model;
    await record();
    return c.json(answer);
  }

  if (!res.body) throw new AppError(502, 'folax_failed', 'Folax returned an empty stream', { provider: 'folax' });
  const upstreamBody = res.body;
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (sse) => {
    // the client left: stop the Folax request too
    sse.onAbort(() => abort.abort());
    // tool steps are answered in one piece after up to minutes: keep proxies (Cloudflare) from dropping the connection
    const heartbeat = setInterval(() => void sse.write(': keepalive\n\n').catch(() => abort.abort()), HEARTBEAT_MS);
    try {
      for await (const msg of parseSse(upstreamBody, abort.signal)) {
        if (msg.data === '[DONE]') {
          await sse.writeSSE({ data: '[DONE]' });
          break;
        }
        await sse.writeSSE({ data: withModel(msg.data, model) });
      }
      await record();
    } catch (err) {
      if (!abort.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        await sse.writeSSE({ data: JSON.stringify({ error: { message: `Folax stream broke: ${message}`, type: 'server_error', code: 'folax_failed', param: null } }) }).catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
      await upstreamBody.cancel().catch(() => {});
    }
  });
}

/** One chunk with `model` set to the public `folax/<model>` id; anything unparsable goes through unchanged. */
function withModel(data: string, model: string): string {
  try {
    const chunk = JSON.parse(data) as Json;
    if (typeof chunk === 'object' && chunk && 'model' in chunk) chunk.model = model;
    return JSON.stringify(chunk);
  } catch {
    return data;
  }
}

/**
 * The message as the adapter takes it: only the OpenAI fields it knows, and images as base64 data URLs (the adapter
 * refuses http(s) URLs, so those are downloaded here). Files are refused: Folax cannot read them.
 */
async function toAdapterMessage(m: unknown): Promise<Json> {
  const msg = (m ?? {}) as Json;
  const out: Json = { role: msg.role };
  for (const key of ['name', 'tool_calls', 'tool_call_id'] as const) if (msg[key] !== undefined) out[key] = msg[key];
  if (!Array.isArray(msg.content)) {
    out.content = msg.content ?? null;
    return out;
  }
  out.content = await Promise.all(
    msg.content.map(async (part: Json) => {
      if (part?.type === 'file') throw badRequest('Folax models cannot read files; send text or images', 'unsupported_attachment', { param: 'messages' });
      if (part?.type !== 'image_url') return part;
      const ref = part.image_url as string | { url?: string } | undefined;
      const url = typeof ref === 'string' ? ref : ref?.url;
      if (!url || url.startsWith('data:')) return part;
      return { type: 'image_url', image_url: { url: await toDataUrl(url) } };
    }),
  );
  return out;
}

async function toDataUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw badRequest('Images must be data URLs or http(s) URLs', 'invalid_image', { param: 'messages' });
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) throw badRequest(`Could not download the image ${url}`, 'invalid_image', { param: 'messages' });
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!IMAGE_TYPES.includes(type)) throw badRequest('Folax takes JPEG, PNG or WebP images', 'invalid_image', { param: 'messages' });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > IMAGE_MAX_BYTES) throw badRequest('Images for Folax are limited to 10 MB', 'invalid_image', { param: 'messages' });
  return `data:${type};base64,${bytes.toString('base64')}`;
}
