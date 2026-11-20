import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, like } from 'drizzle-orm';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversations, usageEvents } from '../../src/db/schema.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Tool calling on Folax models: /v1/chat/completions with `tools` is proxied to the adapter (coding agents). */

let folax: FakeFolax;
let h: Harness;
let openai: OpenAI;
let images: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key } });
  openai = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1`, maxRetries: 0 });
  const png = makePng();
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  images = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/shot.png`, close: () => new Promise<void>((r) => server.close(() => r())) };
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
  await images?.close();
});

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];
const chats = () => folax.callsTo('POST /v1/chat/completions');
const convCount = async () => (await h.ctx.database.db.select().from(conversations)).length;

describe('Folax tool calling', () => {
  it('relays a tool call, then the answer after the tool result, without storing a conversation', async () => {
    const before = await convCount();
    const first = await openai.chat.completions.create({
      model: 'folax/chatgpt',
      messages: [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Baca index.html' }],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    expect(first.model).toBe('folax/chatgpt');
    expect(first.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path": "index.html"}' } }] } });
    expect(chats()[0]!.body).toMatchObject({ model: 'chatgpt', stream: false, tools, tool_choice: 'auto', parallel_tool_calls: false, messages: [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Baca index.html' }] });

    folax.state.chatReply = 'Isinya hello world.';
    const second = await openai.chat.completions.create({
      model: 'folax/chatgpt',
      messages: [
        { role: 'user', content: 'Baca index.html' },
        { role: 'assistant', content: null, tool_calls: first.choices[0]!.message.tool_calls! },
        { role: 'tool', tool_call_id: 'call_1', content: '<h1>Hello World</h1>' },
      ],
      tools,
    });
    expect(second.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'Isinya hello world.' } });
    // the tool result reaches the adapter with its call id
    expect((chats()[1]!.body as any).messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '<h1>Hello World</h1>' });

    expect(await convCount()).toBe(before);
    const usage = await h.ctx.database.db.select().from(usageEvents).where(like(usageEvents.model, 'folax/chatgpt'));
    expect(usage.map((u) => [u.kind, u.creditsTotal])).toEqual([
      ['chat', 0],
      ['chat', 0],
    ]);
  });

  it('streams tool calls in OpenAI chunk format', async () => {
    const stream = await openai.chat.completions.create({ model: 'folax/gemini', stream: true, messages: [{ role: 'user', content: 'Baca index.html' }], tools });
    const models = new Set<string>();
    const calls: { index: number; name?: string; args?: string }[] = [];
    let finish: string | null = null;
    for await (const chunk of stream) {
      models.add(chunk.model);
      for (const call of chunk.choices[0]?.delta?.tool_calls ?? []) calls.push({ index: call.index, name: call.function?.name, args: call.function?.arguments });
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect([...models]).toEqual(['folax/gemini']);
    expect(calls).toEqual([{ index: 0, name: 'read_file', args: '{"path": "index.html"}' }]);
    expect(finish).toBe('tool_calls');
    expect(chats()[0]!.body).toMatchObject({ model: 'gemini', stream: true });
  });

  it('turns http image URLs into data URLs for the adapter', async () => {
    await openai.chat.completions.create({
      model: 'folax/chatgpt',
      messages: [
        { role: 'user', content: 'Ambil screenshot' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: [{ type: 'text', text: 'ini screenshot' }, { type: 'image_url', image_url: { url: images.url } }] as any },
      ],
      tools,
    });
    const tool = (chats()[0]!.body as any).messages[2];
    expect(tool.content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${makePng().toString('base64')}` } });
  });

  it('refuses what Folax cannot do, and keeps Qoder models without tools', async () => {
    await expect(openai.chat.completions.create({ model: 'folax/metaai', messages: [{ role: 'user', content: 'x' }], tools })).rejects.toMatchObject({ status: 400, code: 'model_not_supported' });
    await expect(openai.chat.completions.create({ model: 'folax/nope', messages: [{ role: 'user', content: 'x' }], tools })).rejects.toMatchObject({ status: 400, code: 'model_not_found' });
    await expect(openai.chat.completions.create({ model: 'smart', messages: [{ role: 'user', content: 'x' }], tools })).rejects.toMatchObject({ status: 400, code: 'tools_not_supported' });
    await expect(
      openai.chat.completions.create({ model: 'folax/chatgpt', messages: [{ role: 'user', content: 'x' }], functions: [{ name: 'f', parameters: {} }] } as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(chats()).toHaveLength(0);
  });

  it('invalid tools rejected by the adapter are a 400', async () => {
    folax.failNext('POST /v1/chat/completions', 400, 'invalid_request', undefined, 'tool_choice tidak valid');
    await expect(openai.chat.completions.create({ model: 'folax/chatgpt', messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'required' })).rejects.toMatchObject({ status: 400, code: 'invalid_request', message: expect.stringContaining('tool_choice tidak valid') });
  });

  it('a busy adapter is a 429 before the stream opens', async () => {
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout', { 'Retry-After': '5' });
    await expect(openai.chat.completions.create({ model: 'folax/chatgpt', stream: true, messages: [{ role: 'user', content: 'x' }], tools })).rejects.toMatchObject({ status: 429, code: 'provider_busy' });
  });

  it('Folax chat without tools still goes through the normal conversation path', async () => {
    const before = await convCount();
    folax.state.chatReply = 'Halo!';
    const r = await openai.chat.completions.create({ model: 'folax/chatgpt', messages: [{ role: 'user', content: 'hai' }], tools: [] });
    expect(r.choices[0]!.message.content).toBe('Halo!');
    expect(await convCount()).toBe(before + 1);
    expect((chats()[0]!.body as any).tools).toBeUndefined();
    const row = (await h.ctx.database.db.select().from(conversations).where(eq(conversations.model, 'folax/chatgpt')))[0];
    expect(row).toBeTruthy();
  });
});
