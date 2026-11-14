import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
let client: Anthropic;
beforeAll(async () => {
  h = await startHarness();
  client = new Anthropic({ baseURL: h.url, apiKey: h.apiKey, maxRetries: 0 });
});
afterAll(() => h?.close());

const sessionCount = () => h.qoder.state.sessions.size;
const sessionWith = (text: string) => [...h.qoder.state.sessions.values()].find((s) => s.userTexts.some((t) => t.includes(text)));
const textOf = (m: Anthropic.Message) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

/** Raw SSE request → list of [event, data]. */
async function rawStream(body: Record<string, unknown>): Promise<{ res: Response; events: [string, Record<string, unknown>][] }> {
  const res = await fetch(`${h.url}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': h.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ max_tokens: 100, stream: true, ...body }),
  });
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .filter((f) => f.trim())
    .map((f) => {
      const event = /^event: (.*)$/m.exec(f)?.[1] ?? '';
      const data = JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? '{}') as Record<string, unknown>;
      return [event, data] as [string, Record<string, unknown>];
    });
  return { res, events };
}

describe('Anthropic Messages API', () => {
  it('non-streaming reply with resolved model, usage and headers', async () => {
    const { data, response } = await client.messages
      .create({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'halo' }], stop_sequences: ['END'] })
      .withResponse();
    expect(data).toMatchObject({ type: 'message', role: 'assistant', model: 'qoder/auto', stop_reason: 'end_turn', stop_sequence: null });
    expect(data.id).toMatch(/^msg_/);
    expect(data.content).toEqual([{ type: 'text', text: '[auto] Echo #1: halo' }]);
    expect(data.usage.input_tokens).toBeGreaterThan(0);
    expect(data.usage.output_tokens).toBeGreaterThan(0);
    expect((data.usage as unknown as { stillgpt_credits: number }).stillgpt_credits).toBeCloseTo(0.01);
    expect(response.headers.get('x-stillgpt-conversation')).toMatch(/^conv_/);
    expect(response.headers.get('x-stillgpt-model')).toBe('qoder/auto');
    expect(response.headers.get('x-stillgpt-credits')).toBe('0.01');
  });

  it('streams the exact Anthropic event sequence; SDK final message equals the deltas', async () => {
    const stream = client.messages.stream({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'stream please' }] });
    let deltas = '';
    stream.on('text', (t) => (deltas += t));
    const types: string[] = [];
    for await (const ev of stream) types.push(ev.type);
    const final = await stream.finalMessage();
    expect(textOf(final)).toBe('[auto] Echo #1: stream please');
    expect(deltas).toBe(textOf(final));
    expect(final.model).toBe('qoder/auto');
    expect(final.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBeGreaterThan(0);
    expect(types[0]).toBe('message_start');
    expect(types[1]).toBe('content_block_start');
    expect(types.slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    expect(types.filter((t) => t === 'content_block_delta').length).toBeGreaterThan(1);
  });

  it('raw SSE has event names, ping and headers', async () => {
    const { res, events } = await rawStream({ model: 'cheap', messages: [{ role: 'user', content: 'raw' }] });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('x-stillgpt-model')).toBe('qoder/efficient');
    const names = events.map(([e]) => e);
    expect(names.slice(0, 3)).toEqual(['message_start', 'content_block_start', 'ping']);
    expect(names.slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    for (const [event, data] of events) expect(data.type).toBe(event);
    const start = events[0]![1].message as { model: string; content: unknown[]; usage: { input_tokens: number } };
    expect(start.model).toBe('qoder/efficient');
    expect(start.content).toEqual([]);
    expect(start.usage.input_tokens).toBeGreaterThan(0);
    const text = events
      .filter(([e]) => e === 'content_block_delta')
      .map(([, d]) => (d.delta as { type: string; text: string }).text)
      .join('');
    expect(text).toBe('[efficient] Echo #1: raw');
    expect(events.at(-2)![1]).toMatchObject({ delta: { stop_reason: 'end_turn', stop_sequence: null } });
  });

  it('reuses the session when the client resends history (fingerprint hit)', async () => {
    const first = await client.messages.create({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'first-hit' }] });
    const before = sessionCount();
    const second = await client.messages.create({
      model: 'default',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'first-hit' },
        { role: 'assistant', content: first.content as Anthropic.TextBlockParam[] },
        { role: 'user', content: [{ type: 'text', text: 'again [[history]]' }] },
      ],
    });
    expect(textOf(second)).toContain('Echo #2');
    expect(textOf(second)).toContain('History: first-hit');
    expect(sessionCount()).toBe(before);
  });

  it('reuses a streamed reply as history too', async () => {
    const stream = client.messages.stream({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'streamed-first' }] });
    const first = await stream.finalMessage();
    const before = sessionCount();
    const second = await client.messages.create({
      model: 'default',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'streamed-first' },
        { role: 'assistant', content: textOf(first) },
        { role: 'user', content: 'next [[history]]' },
      ],
    });
    expect(textOf(second)).toContain('Echo #2');
    expect(sessionCount()).toBe(before);
  });

  it('pins a conversation with X-StillGPT-Conversation or metadata.conversation_id', async () => {
    const { response } = await client.messages.create({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'pin-one' }] }).withResponse();
    const conv = response.headers.get('x-stillgpt-conversation')!;
    const before = sessionCount();
    const viaHeader = await client.messages.create(
      { model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'pin-two [[history]]' }] },
      { headers: { 'X-StillGPT-Conversation': conv } },
    );
    expect(textOf(viaHeader)).toContain('Echo #2');
    expect(textOf(viaHeader)).toContain('History: pin-one');
    const viaMetadata = await client.messages.create({
      model: 'default',
      max_tokens: 100,
      metadata: { user_id: 'u1', conversation_id: conv } as Anthropic.Metadata,
      messages: [{ role: 'user', content: 'pin-three' }],
    });
    expect(textOf(viaMetadata)).toContain('Echo #3');
    expect(sessionCount()).toBe(before);
  });

  it('replays unknown history as a transcript on a new session', async () => {
    const before = sessionCount();
    const r = await client.messages.create({
      model: 'default',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'never-seen-question' },
        { role: 'assistant', content: 'never-seen-answer' },
        { role: 'user', content: 'follow-up' },
      ],
    });
    expect(sessionCount()).toBe(before + 1);
    expect(textOf(r)).toContain('Echo #1');
    expect(textOf(r)).toContain('Conversation so far');
    expect(textOf(r)).toContain('Assistant: never-seen-answer');
  });

  it('applies the system prompt (string and text blocks) to the session', async () => {
    await client.messages.create({ model: 'default', max_tokens: 100, system: 'You are SYSTEM-STRING.', messages: [{ role: 'user', content: 'sys-a' }] });
    expect(sessionWith('sys-a')!.agent.system).toContain('You are SYSTEM-STRING.');
    await client.messages.create({
      model: 'default',
      max_tokens: 100,
      system: [{ type: 'text', text: 'Block one.' }, { type: 'text', text: 'Block two.' }],
      messages: [{ role: 'user', content: 'sys-b' }],
    });
    expect(sessionWith('sys-b')!.agent.system).toContain('Block one.\nBlock two.');
  });

  it('passes base64 images to the agent', async () => {
    const r = await client.messages.create({
      model: 'vision',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: makePng().toString('base64') } },
            { type: 'text', text: 'what is this' },
          ],
        },
      ],
    });
    expect(textOf(r)).toContain('(saw 1 image(s))');
  });

  it('mounts PDF and text documents in the sandbox', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake\n1 0 obj\n%%EOF\n');
    const r = await client.messages.create({
      model: 'default',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', title: 'report', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
            { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'first line of notes\nsecond' } },
            { type: 'text', text: 'summarise [[doc]]' },
          ],
        },
      ],
    });
    expect(textOf(r)).toContain('/data/attachments/report.pdf: %PDF-1.4 fake');
    expect(textOf(r)).toContain('/data/attachments/notes.txt: first line of notes');
  });

  it('resolves aliases and namespaced ids', async () => {
    const cheap = await client.messages.create({ model: 'cheap', max_tokens: 100, messages: [{ role: 'user', content: 'alias' }] });
    expect(cheap.model).toBe('qoder/efficient');
    expect(textOf(cheap)).toBe('[efficient] Echo #1: alias');
    const fast = await client.messages.create({ model: 'qoder/fast', max_tokens: 100, messages: [{ role: 'user', content: 'ns' }] });
    expect(fast.model).toBe('qoder/fast');
  });

  it('appends artifacts as markdown links with the assistant profile', async () => {
    const r = await client.messages.create(
      { model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'draw a cat [[image]]' }] },
      { headers: { 'X-StillGPT-Profile': 'assistant' } },
    );
    expect(textOf(r)).toMatch(/\n\n!\[draw-a-cat\.png\]\(http:\/\/127\.0\.0\.1:\d+\/media\/file_\w+\?exp=\d+&sig=[\w-]+\)$/);
  });

  it('accepts and ignores sampling/thinking parameters', async () => {
    const res = await h.api('/v1/messages', {
      method: 'POST',
      json: {
        model: 'default',
        max_tokens: 10,
        temperature: 0.3,
        top_k: 5,
        top_p: 0.9,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'sampling' }],
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe('[auto] Echo #1: sampling');
  });

  it('counts tokens', async () => {
    const r = await client.messages.countTokens({ model: 'default', system: 'sys', messages: [{ role: 'user', content: 'a'.repeat(400) }] });
    expect(r.input_tokens).toBeGreaterThanOrEqual(100);
  });
});

describe('Anthropic errors', () => {
  it('bad key → AuthenticationError with Anthropic envelope', async () => {
    const bad = new Anthropic({ baseURL: h.url, apiKey: 'sg_nope', maxRetries: 0 });
    const err = await bad.messages.create({ model: 'default', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
    expect((err as InstanceType<typeof Anthropic.AuthenticationError>).error).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('tools → 400 tools_not_supported', async () => {
    const err = await client.messages
      .create({
        model: 'default',
        max_tokens: 10,
        tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'weather?' }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect((err as InstanceType<typeof Anthropic.BadRequestError>).error).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });

    const viaBlocks = await client.messages
      .create({
        model: 'default',
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
        ],
      })
      .catch((e: unknown) => e);
    expect(viaBlocks).toBeInstanceOf(Anthropic.BadRequestError);
  });

  it('validation errors: missing max_tokens, final assistant message, bad profile', async () => {
    const missing = await h.api('/v1/messages', { method: 'POST', json: { model: 'default', messages: [{ role: 'user', content: 'x' }] } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });

    const prefill = await client.messages
      .create({ model: 'default', max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] })
      .catch((e: unknown) => e);
    expect(prefill).toBeInstanceOf(Anthropic.BadRequestError);

    const profile = await client.messages
      .create({ model: 'default', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { headers: { 'X-StillGPT-Profile': 'video' } })
      .catch((e: unknown) => e);
    expect(profile).toBeInstanceOf(Anthropic.BadRequestError);
  });

  it('upstream failure → 502 api_error (non-streaming) and error event (streaming)', async () => {
    const err = await client.messages.create({ model: 'default', max_tokens: 10, messages: [{ role: 'user', content: 'boom [[error]]' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(502);
    expect((err as InstanceType<typeof Anthropic.APIError>).error).toMatchObject({ type: 'error', error: { type: 'api_error' } });

    const { events } = await rawStream({ model: 'default', messages: [{ role: 'user', content: 'boom again [[error]]' }] });
    const last = events.at(-1)!;
    expect(last[0]).toBe('error');
    expect(last[1]).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(events.map(([e]) => e)).not.toContain('message_stop');
  });

  it('batches → 501 in the Anthropic envelope', async () => {
    const res = await h.api('/v1/messages/batches', { method: 'POST', json: { requests: [] } });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect((await h.api('/v1/messages/batches/msgbatch_1')).status).toBe(501);
  });
});
