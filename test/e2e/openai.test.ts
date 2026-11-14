import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
let client: OpenAI;

beforeAll(async () => {
  h = await startHarness();
  client = new OpenAI({ baseURL: `${h.url}/v1`, apiKey: h.apiKey, maxRetries: 0 });
});
afterAll(() => h?.close());

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const sessionCount = () => h.qoder.state.sessions.size;
const sessionOf = (conversationId: string) => h.ctx.conversations.get(conversationId).then((c) => h.qoder.state.sessions.get(c.qoderSessionId!)!);

async function chat(messages: Msg[], opts: { model?: string; headers?: Record<string, string> } = {}) {
  const { data, response } = await client.chat.completions
    .create({ model: opts.model ?? 'default', messages }, { headers: opts.headers })
    .withResponse();
  return { completion: data, conversationId: response.headers.get('x-stillgpt-conversation')!, headers: response.headers };
}

describe('OpenAI chat completions', () => {
  it('returns a non-streaming completion with usage, credits and compat headers', async () => {
    const { completion, conversationId, headers } = await chat([{ role: 'user', content: 'halo' }]);
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('qoder/auto');
    expect(completion.choices[0]!.message.content).toBe('[auto] Echo #1: halo');
    expect(completion.choices[0]!.finish_reason).toBe('stop');
    expect(completion.usage!.completion_tokens).toBeGreaterThan(0);
    expect(completion.usage!.total_tokens).toBe(completion.usage!.prompt_tokens + completion.usage!.completion_tokens);
    expect((completion.usage as unknown as { stillgpt_credits: number }).stillgpt_credits).toBeCloseTo(0.01);
    expect(conversationId).toMatch(/^conv_/);
    expect(headers.get('x-stillgpt-model')).toBe('auto');
    expect(headers.get('x-stillgpt-credits')).toBe('0.01');
  });

  it('streams deltas that add up to the final text, then a usage chunk', async () => {
    const stream = await client.chat.completions.create({
      model: 'default',
      messages: [{ role: 'user', content: 'stream me please' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const ch of stream) chunks.push(ch);

    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    const text = chunks.map((ch) => ch.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('[auto] Echo #1: stream me please');
    expect(chunks.filter((ch) => (ch.choices[0]?.delta.content ?? '').length > 0).length).toBeGreaterThan(1);
    const finish = chunks.find((ch) => ch.choices[0]?.finish_reason);
    expect(finish!.choices[0]!.finish_reason).toBe('stop');
    const last = chunks.at(-1)!;
    expect(last.choices).toEqual([]);
    expect(last.usage!.completion_tokens).toBeGreaterThan(0);
    expect(chunks.every((ch) => ch.model === 'qoder/auto')).toBe(true);
  });

  it('reuses the conversation when the client resends the full history', async () => {
    const before = sessionCount();
    const first = await chat([{ role: 'user', content: 'pertama' }]);
    const reply = first.completion.choices[0]!.message.content!;
    expect(sessionCount()).toBe(before + 1);

    const second = await chat([
      { role: 'user', content: 'pertama' },
      { role: 'assistant', content: reply },
      { role: 'user', content: 'kedua [[history]]' },
    ]);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.completion.choices[0]!.message.content).toContain('Echo #2: kedua');
    expect(second.completion.choices[0]!.message.content).toContain('History: pertama');
    expect(sessionCount()).toBe(before + 1);
  });

  it('reuses the conversation after a streamed reply too', async () => {
    const stream = await client.chat.completions.create({ model: 'cheap', messages: [{ role: 'user', content: 'satu' }], stream: true });
    let reply = '';
    for await (const ch of stream) reply += ch.choices[0]?.delta.content ?? '';
    const before = sessionCount();
    const next = await chat(
      [
        { role: 'user', content: 'satu' },
        { role: 'assistant', content: reply },
        { role: 'user', content: 'dua' },
      ],
      { model: 'cheap' },
    );
    expect(next.completion.choices[0]!.message.content).toBe('[efficient] Echo #2: dua');
    expect(sessionCount()).toBe(before);
  });

  it('replays unknown history as a transcript on a new session', async () => {
    const before = sessionCount();
    const { completion } = await chat([
      { role: 'user', content: 'apa ibukota Prancis?' },
      { role: 'assistant', content: 'Paris, tentu saja.' },
      { role: 'user', content: 'dan Jerman?' },
    ]);
    const content = completion.choices[0]!.message.content!;
    expect(content).toContain('Echo #1');
    expect(content).toContain('Paris, tentu saja.');
    expect(content).toContain('dan Jerman?');
    expect(sessionCount()).toBe(before + 1);
  });

  it('honours X-StillGPT-Conversation explicitly', async () => {
    const first = await chat([{ role: 'user', content: 'ingat ini' }]);
    const { completion } = await chat([{ role: 'user', content: 'lanjut [[history]]' }], { headers: { 'X-StillGPT-Conversation': first.conversationId } });
    expect(completion.choices[0]!.message.content).toContain('Echo #2');
    expect(completion.choices[0]!.message.content).toContain('History: ingat ini');
  });

  it('resolves aliases and namespaced ids', async () => {
    expect((await chat([{ role: 'user', content: 'a' }], { model: 'cheap' })).completion.choices[0]!.message.content).toBe('[efficient] Echo #1: a');
    const fast = await chat([{ role: 'user', content: 'b' }], { model: 'qoder/fast' });
    expect(fast.completion.choices[0]!.message.content).toBe('[fast] Echo #1: b');
    expect(fast.completion.model).toBe('qoder/fast');
  });

  it('falls back when a model was retired upstream', async () => {
    h.qoder.retireModel('dfmodel');
    const { completion } = await chat([{ role: 'user', content: 'masih jalan?' }], { model: 'qoder/dfmodel' });
    expect(completion.choices[0]!.message.content).toMatch(/^\[auto\] Echo #1: masih jalan\?$/);
    expect(completion.model).toBe('qoder/auto');
  });

  it('passes images (data URL) to the agent', async () => {
    const url = `data:image/png;base64,${makePng().toString('base64')}`;
    const { completion } = await chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'lihat' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ]);
    expect(completion.choices[0]!.message.content).toBe('[auto] Echo #1: lihat (saw 1 image(s))');
  });

  it('mounts file parts as documents', async () => {
    const file_data = `data:text/plain;base64,${Buffer.from('baris pertama\nbaris dua').toString('base64')}`;
    const { completion } = await chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'baca [[doc]]' },
          { type: 'file', file: { file_data, filename: 'catatan.txt' } },
        ],
      },
    ]);
    expect(completion.choices[0]!.message.content).toMatch(/catatan\.txt: baris pertama/);
  });

  it('applies system/developer messages to the session', async () => {
    const { conversationId } = await chat([
      { role: 'system', content: 'Kamu bajak laut.' },
      { role: 'developer', content: 'Selalu singkat.' },
      { role: 'user', content: 'hai' },
    ]);
    const session = await sessionOf(conversationId);
    expect(session.agent.system).toContain('Kamu bajak laut.\n\nSelalu singkat.');
  });

  it('turns response_format into a JSON instruction', async () => {
    const { conversationId } = await client.chat.completions
      .create({
        model: 'default',
        messages: [{ role: 'user', content: 'json pls' }],
        response_format: { type: 'json_schema', json_schema: { name: 'thing', schema: { type: 'object', properties: { a: { type: 'string' } } } } },
      })
      .withResponse()
      .then(({ response }) => ({ conversationId: response.headers.get('x-stillgpt-conversation')! }));
    const session = await sessionOf(conversationId);
    expect(session.agent.system).toContain('JSON');
    expect(session.agent.system).toContain('"properties":{"a":{"type":"string"}}');
  });

  it('returns generated images as markdown links that download (assistant profile)', async () => {
    const { completion } = await chat([{ role: 'user', content: 'gambar kucing [[image]]' }], { headers: { 'X-StillGPT-Profile': 'assistant' } });
    const content = completion.choices[0]!.message.content!;
    const link = content.match(/!\[([^\]]+)\]\((http[^)]+)\)/);
    expect(link?.[1]).toBe('gambar-kucing.png');
    const res = await fetch(link![2]!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    // the link must not break history matching on the next call
    const before = sessionCount();
    const next = await chat(
      [
        { role: 'user', content: 'gambar kucing [[image]]' },
        { role: 'assistant', content },
        { role: 'user', content: 'terima kasih' },
      ],
      { headers: { 'X-StillGPT-Profile': 'assistant' } },
    );
    expect(next.completion.choices[0]!.message.content).toContain('Echo #2');
    expect(sessionCount()).toBe(before);
  });

  it('streams artifact links after the text', async () => {
    const stream = await client.chat.completions.create(
      { model: 'default', messages: [{ role: 'user', content: 'lukis [[image]]' }], stream: true },
      { headers: { 'X-StillGPT-Profile': 'assistant' } },
    );
    let text = '';
    for await (const ch of stream) text += ch.choices[0]?.delta.content ?? '';
    expect(text).toMatch(/Delivered lukis\.png\n\n!\[lukis\.png\]\(http[^)]+\/media\/file_[^)]+\)$/);
  });
});

describe('OpenAI errors', () => {
  it('rejects a bad API key with an OpenAI 401 envelope', async () => {
    const bad = new OpenAI({ baseURL: `${h.url}/v1`, apiKey: 'sg_nope', maxRetries: 0 });
    await expect(bad.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
    const res = await fetch(`${h.url}/v1/models`, { headers: { authorization: 'Bearer sg_nope' } });
    const body = (await res.json()) as { error: { type: string } };
    expect(res.status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('rejects tools with tools_not_supported (unless tool_choice none)', async () => {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
    const err = await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'x' }], tools }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect((err as InstanceType<typeof OpenAI.BadRequestError>).code).toBe('tools_not_supported');

    const ok = await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'tanpa alat' }], tools, tool_choice: 'none' });
    expect(ok.choices[0]!.message.content).toContain('tanpa alat');
  });

  it('validates the request', async () => {
    const cases: unknown[] = [
      { model: 'default', messages: [] },
      { model: 'default', messages: [{ role: 'user', content: 'x' }], n: 2 },
      { model: 'default', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] },
      { model: 'qoder-image', messages: [{ role: 'user', content: 'x' }] },
    ];
    for (const json of cases) {
      const res = await h.api('/v1/chat/completions', { method: 'POST', json });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe('invalid_request_error');
    }
  });

  it('maps upstream turn failures to 502 and streams them as error frames', async () => {
    const err = await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'boom [[error]]' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.InternalServerError);
    expect((err as Error).message).toContain('mock failure');
  });

  it('ends a failing stream with an error frame', async () => {
    const stream = await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'boom stream [[error]]' }], stream: true });
    const err = await (async () => {
      for await (const _ of stream);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.APIError);
    expect((err as Error).message).toContain('mock failure');
  });

  it('answers unknown routes and unsupported APIs with OpenAI envelopes', async () => {
    const unknown = await h.api('/v1/nope', { method: 'POST', json: {} });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { type: string } }).error.type).toBe('not_found_error');
    const emb = await client.embeddings.create({ model: 'default', input: 'x' }).catch((e: unknown) => e);
    expect((emb as InstanceType<typeof OpenAI.APIError>).status).toBe(501);
    expect((emb as InstanceType<typeof OpenAI.APIError>).code).toBe('not_supported');
  });
});

describe('OpenAI models', () => {
  it('lists aliases, qoder/<id> models and media models', async () => {
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    expect(ids).toEqual(expect.arrayContaining(['default', 'smart', 'cheap', 'qoder/auto', 'qoder/ultimate', 'qoder-image', 'qoder-video']));
    expect(ids).not.toContain('qoder/dfmodel'); // retired above

    const cheap = (await client.models.retrieve('cheap')) as OpenAI.Models.Model & { stillgpt: { resolves_to: string } };
    expect(cheap.owned_by).toBe('qoder');
    expect(cheap.stillgpt.resolves_to).toBe('qoder/efficient');
    expect((await client.models.retrieve('qoder/fast')).id).toBe('qoder/fast');
    await expect(client.models.retrieve('nonexistent')).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it('answers in Anthropic format when anthropic-version is present', async () => {
    const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': h.apiKey, authorization: '' };
    const res = await fetch(`${h.url}/v1/models`, { headers });
    const body = (await res.json()) as { data: { type: string; id: string; display_name: string; created_at: string }[]; has_more: boolean; first_id: string };
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe(body.data[0]!.id);
    const auto = body.data.find((m) => m.id === 'qoder/auto')!;
    expect(auto).toMatchObject({ type: 'model', display_name: 'Auto' });
    expect(new Date(auto.created_at).getTime()).toBeGreaterThan(0);

    const one = await fetch(`${h.url}/v1/models/smart`, { headers });
    expect(((await one.json()) as { type: string }).type).toBe('model');
    const missing = await fetch(`${h.url}/v1/models/nope`, { headers });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { type: string }).type).toBe('error');
  });
});

describe('OpenAI Responses API', () => {
  it('answers a string input with instructions', async () => {
    const { data, response } = await client.responses.create({ model: 'cheap', input: 'halo responses', instructions: 'Jawab sopan.' }).withResponse();
    expect(data.status).toBe('completed');
    expect(data.output_text).toBe('[efficient] Echo #1: halo responses');
    expect(data.model).toBe('qoder/efficient');
    const session = await sessionOf(response.headers.get('x-stillgpt-conversation')!);
    expect(session.agent.system).toContain('Jawab sopan.');
  });

  it('streams output_text deltas and completes', async () => {
    const stream = await client.responses.create({ model: 'default', input: [{ role: 'user', content: 'alir' }], stream: true });
    const types: string[] = [];
    let text = '';
    let final: OpenAI.Responses.Response | undefined;
    for await (const ev of stream) {
      types.push(ev.type);
      if (ev.type === 'response.output_text.delta') text += ev.delta;
      if (ev.type === 'response.completed') final = ev.response;
    }
    expect(types[0]).toBe('response.created');
    expect(types.at(-1)).toBe('response.completed');
    expect(text).toBe('[auto] Echo #1: alir');
    expect(final!.output_text).toBe(text);
  });

  it('reuses conversations across message-list inputs', async () => {
    const first = await client.responses.create({ model: 'default', input: [{ role: 'user', content: 'r1' }] });
    const second = await client.responses.create({
      model: 'default',
      input: [
        { role: 'user', content: 'r1' },
        { role: 'assistant', content: first.output_text },
        { role: 'user', content: 'r2 [[history]]' },
      ],
    });
    expect(second.output_text).toContain('Echo #2: r2');
    expect(second.output_text).toContain('History: r1');
  });
});
