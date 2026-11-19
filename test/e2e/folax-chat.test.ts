import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversations, usageEvents } from '../../src/db/schema.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Folax chat models (`folax/<model>`) on the native, OpenAI and Anthropic surfaces, and their effect on Qoder chats. */

let folax: FakeFolax;
let h: Harness;
let openai: OpenAI;
let anthropic: Anthropic;
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key } });
  openai = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1`, maxRetries: 0 });
  anthropic = new Anthropic({ apiKey: h.apiKey, baseURL: h.url, maxRetries: 0 });
});
afterEach(() => folax.reset());
afterAll(async () => {
  await h?.close();
  await folax?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const createConv = async (payload: Record<string, unknown>) => json(await h.api('/api/v1/conversations', { method: 'POST', json: payload }));
const send = async (convId: string, payload: Record<string, unknown>) => json(await h.api(`/api/v1/conversations/${convId}/messages`, { method: 'POST', json: payload }));
const patchConv = async (convId: string, payload: Record<string, unknown>) => json(await h.api(`/api/v1/conversations/${convId}`, { method: 'PATCH', json: payload }));
const convRow = async (id: string) => (await h.ctx.database.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;
const chats = () => folax.callsTo('POST /v1/chat/completions');
const textOf = (m: any) => (typeof m.content === 'string' ? m.content : m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'));

async function upload(bytes: Buffer, type: string, name: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('model catalog', () => {
  it('native GET /models lists Folax chat models next to Qoder ones', async () => {
    const r = await json(await h.api('/api/v1/models'));
    const ids = r.body.data.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['folax/folax', 'folax/chatgpt', 'folax/gemini', 'folax/metaai', 'folax/grok']));
    expect(r.body.data.find((m: any) => m.id === 'folax/chatgpt')).toMatchObject({ display_name: 'ChatGPT (via Folax)', provider: 'folax', price_factor: 0, vision: true });
    expect(r.body.data.filter((m: any) => !m.id.startsWith('folax/')).every((m: any) => m.provider === 'qoder')).toBe(true);
  });

  it('OpenAI and Anthropic /models list them owned by folax', async () => {
    const list = await openai.models.list();
    const gemini = list.data.find((m) => m.id === 'folax/gemini') as any;
    expect(gemini).toMatchObject({ owned_by: 'folax', stillgpt: { kind: 'model', provider: 'folax', tools: false } });
    expect(list.data.find((m) => m.id.startsWith('qoder/'))?.owned_by).toBe('qoder');
    expect((await openai.models.retrieve('folax/grok')).id).toBe('folax/grok');
    const a = await anthropic.models.list();
    expect(a.data.map((m) => m.id)).toContain('folax/metaai');
  });
});

describe('native chat on a Folax model', () => {
  it('streams the answer, stores it with the Folax model, free, and sends the full context', async () => {
    const conv = await createConv({ model: 'folax/chatgpt', system_prompt: 'Jawab singkat.' });
    expect(conv.status).toBe(201);

    folax.state.chatReply = 'Mercusuar adalah menara suar.';
    const first = await send(conv.body.id, { text: 'Apa itu mercusuar?' });
    expect(first.status).toBe(200);
    expect(first.body.message).toMatchObject({ role: 'assistant', model: 'folax/chatgpt', stop_reason: 'end_turn' });
    expect(textOf(first.body.message)).toBe('Mercusuar adalah menara suar.');

    const req1 = folax.lastChat()!;
    expect(req1).toMatchObject({ model: 'chatgpt', stream: true });
    expect(req1.messages[0].role).toBe('system');
    expect(req1.messages[0].content).toContain('Jawab singkat.');
    expect(req1.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Apa itu mercusuar?' }] });

    folax.state.chatReply = 'Ada di pantai.';
    await send(conv.body.id, { text: 'Di mana biasanya?' });
    const req2 = folax.lastChat()!;
    expect(req2.messages.slice(1)).toEqual([
      { role: 'user', content: 'Apa itu mercusuar?' },
      { role: 'assistant', content: 'Mercusuar adalah menara suar.' },
      { role: 'user', content: [{ type: 'text', text: 'Di mana biasanya?' }] },
    ]);

    // no Qoder session, no credits, but counted in usage
    const row = await convRow(conv.body.id);
    expect(row.qoderSessionId).toBeNull();
    const usage = await h.ctx.database.db.select().from(usageEvents).where(eq(usageEvents.conversationId, conv.body.id));
    expect(usage.map((u) => [u.model, u.creditsTotal])).toEqual([
      ['folax/chatgpt', 0],
      ['folax/chatgpt', 0],
    ]);
  });

  it('sends images of the current message as data URLs and earlier ones as markers', async () => {
    const png = makePng();
    const img = await upload(png, 'image/png', 'foto.png');
    const conv = await createConv({ model: 'folax/gemini' });
    await send(conv.body.id, { content: [{ type: 'text', text: 'Ini apa?' }, { type: 'image', file_id: img.id }] });
    const last = folax.lastChat()!.messages.at(-1);
    expect(last.content).toEqual([
      { type: 'text', text: 'Ini apa?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
    ]);
    await send(conv.body.id, { text: 'Warnanya?' });
    expect(folax.lastChat()!.messages.at(-3)).toEqual({ role: 'user', content: 'Ini apa?\n[image]' });
  });

  it('rejects files and unknown Folax models before anything is stored', async () => {
    const doc = await upload(Buffer.from('halo'), 'text/plain', 'catatan.txt');
    const conv = await createConv({ model: 'folax/grok' });
    const r = await send(conv.body.id, { text: 'baca ini', attachments: [doc.id] });
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'unsupported_attachment' } } });
    const msgs = await json(await h.api(`/api/v1/conversations/${conv.body.id}/messages`));
    expect(msgs.body.data).toHaveLength(0);
    expect((await convRow(conv.body.id)).status).toBe('idle');

    expect(await createConv({ model: 'folax/deepseek' })).toMatchObject({ status: 400, body: { error: { code: 'model_not_found' } } });
    expect((await patchConv(conv.body.id, { model: 'folax/nope' })).status).toBe(400);
    expect((await send(conv.body.id, { text: 'x'.repeat(12_001) })).body.error.code).toBe('message_too_long');
    expect(chats()).toHaveLength(0);
  });

  it('keeps the partial text when the stream breaks, and fails the turn', async () => {
    const conv = await createConv({ model: 'folax/folax' });
    folax.state.chatReply = 'Jawaban yang panjang sekali';
    folax.state.chatMidError = 'upstream_error';
    const r = await send(conv.body.id, { text: 'halo' });
    expect(r.body.message).toMatchObject({ stop_reason: 'error', error: { code: 'folax_failed' } });
    expect(textOf(r.body.message)).toBe('Jawaban ');
    expect((await convRow(conv.body.id)).status).toBe('idle');
  });

  it('a stream that ends without finishing is an error', async () => {
    const conv = await createConv({ model: 'folax/folax' });
    folax.state.chatNoStop = true;
    const r = await send(conv.body.id, { text: 'halo' });
    expect(r.body.message).toMatchObject({ stop_reason: 'error', error: { code: 'folax_failed' } });
  });

  it('interrupt stops the Folax request and keeps what was said', async () => {
    const conv = await createConv({ model: 'folax/chatgpt' });
    folax.state.chatReply = 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh';
    folax.state.chatPieceDelayMs = 60;
    const pending = send(conv.body.id, { text: 'hitung' });
    await waitFor(() => folax.chatStreams.open, (n) => n === 1);
    await new Promise((r) => setTimeout(r, 150));
    const it = await json(await h.api(`/api/v1/conversations/${conv.body.id}/interrupt`, { method: 'POST' }));
    expect(it.body).toEqual({ interrupted: true });
    const r = await pending;
    expect(r.body.message.stop_reason).toBe('interrupted');
    expect(textOf(r.body.message).length).toBeGreaterThan(0);
    expect(textOf(r.body.message).length).toBeLessThan(folax.state.chatReply!.length);
    await waitFor(() => folax.chatStreams.aborted, (n) => n >= 1);
  });

  it('a busy adapter fails the turn with provider_busy', async () => {
    const conv = await createConv({ model: 'folax/chatgpt' });
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout', { 'Retry-After': '5' });
    const r = await send(conv.body.id, { text: 'halo' });
    expect(r.body.message).toMatchObject({ stop_reason: 'error', error: { code: 'provider_busy' } });
  });
});

describe('switching a conversation between Qoder and Folax', () => {
  it('Qoder → Folax → Qoder keeps the whole conversation on both sides', async () => {
    const conv = await createConv({});
    await send(conv.body.id, { text: 'nama saya Budi' });
    const qoderSession = (await convRow(conv.body.id)).qoderSessionId!;
    expect(qoderSession).toBeTruthy();

    await patchConv(conv.body.id, { model: 'folax/gemini' });
    folax.state.chatReply = 'Halo Budi!';
    await send(conv.body.id, { text: 'siapa nama saya?' });
    // Folax got the Qoder turn as history
    expect(folax.lastChat()!.messages.slice(1, 2)).toEqual([{ role: 'user', content: 'nama saya Budi' }]);
    // the Qoder session (which misses the Folax turn) was let go
    const afterFolax = await convRow(conv.body.id);
    expect(afterFolax.qoderSessionId).toBeNull();
    expect(afterFolax.metadata?.usage).toBeUndefined();
    await waitFor(() => h.qoder.state.sessions.get(qoderSession)?.archived_at, (v) => !!v);

    await patchConv(conv.body.id, { model: 'default' });
    const back = await send(conv.body.id, { text: 'lanjut' });
    expect(back.body.message.stop_reason).toBe('end_turn');
    const newSession = (await convRow(conv.body.id)).qoderSessionId!;
    expect(newSession).not.toBe(qoderSession);
    // the new Qoder session got the transcript, including Folax's reply
    const sent = h.qoder.state.sessions.get(newSession)!.userTexts.join('\n');
    expect(sent).toContain('nama saya Budi');
    expect(sent).toContain('Halo Budi!');
    expect(sent).toContain('lanjut');
  });
});

describe('a refused Folax turn', () => {
  it('leaves the Qoder session alone when Folax does not accept the turn', async () => {
    const conv = await createConv({});
    await send(conv.body.id, { text: 'halo qoder' });
    const session = (await convRow(conv.body.id)).qoderSessionId!;
    await patchConv(conv.body.id, { model: 'folax/chatgpt' });
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout');
    const r = await send(conv.body.id, { text: 'halo folax' });
    expect(r.body.message.error.code).toBe('provider_busy');
    expect((await convRow(conv.body.id)).qoderSessionId).toBe(session);
    expect(h.qoder.state.sessions.get(session)?.archived_at).toBeNull();
  });

  it('compat requests a Folax model cannot take fail before a conversation is created', async () => {
    const before = (await h.ctx.database.db.select().from(conversations)).length;
    const pdf = Buffer.from('%PDF-1.4 halo').toString('base64');
    await expect(
      anthropic.messages.create({
        model: 'folax/gemini',
        max_tokens: 50,
        messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }, { type: 'text', text: 'baca' }] }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(openai.chat.completions.create({ model: 'folax/nope', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 400 });
    expect((await h.ctx.database.db.select().from(conversations)).length).toBe(before);
    expect(chats()).toHaveLength(0);
  });
});

describe('OpenAI-compatible chat', () => {
  it('non-streaming and streaming replies carry the folax/ model id', async () => {
    folax.state.chatReply = 'Halo!';
    const r = await openai.chat.completions.create({ model: 'folax/gemini', messages: [{ role: 'user', content: 'hai' }] });
    expect(r.model).toBe('folax/gemini');
    expect(r.choices[0]!.message.content).toBe('Halo!');
    expect(folax.lastChat()!.model).toBe('gemini');

    folax.state.chatReply = 'Ini jawaban streaming.';
    const stream = await openai.chat.completions.create({ model: 'folax/chatgpt', stream: true, messages: [{ role: 'user', content: 'stream dong' }] });
    let text = '';
    const models = new Set<string>();
    let finish: string | null = null;
    for await (const ch of stream) {
      models.add(ch.model);
      text += ch.choices[0]?.delta?.content ?? '';
      finish = ch.choices[0]?.finish_reason ?? finish;
    }
    expect(text).toBe('Ini jawaban streaming.');
    expect([...models]).toEqual(['folax/chatgpt']);
    expect(finish).toBe('stop');
  });

  it('passes data-URL images through and keeps stateless history', async () => {
    const png = makePng();
    await openai.chat.completions.create({
      model: 'folax/gemini',
      messages: [
        { role: 'system', content: 'Kamu asisten.' },
        { role: 'user', content: 'halo' },
        { role: 'assistant', content: 'hai juga' },
        { role: 'user', content: [{ type: 'text', text: 'lihat ini' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] },
      ],
    });
    const sent = folax.lastChat()!.messages;
    expect(sent[0].content).toContain('Kamu asisten.');
    const last = sent.at(-1);
    expect(last.content[0].text).toContain('hai juga'); // unknown history arrives as the transcript preamble
    expect(last.content.at(-1)).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } });
  });

  it('maps Folax failures to proper HTTP statuses', async () => {
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout', { 'Retry-After': '5' });
    await expect(openai.chat.completions.create({ model: 'folax/chatgpt', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 429, code: 'provider_busy' });
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout');
    await expect(openai.chat.completions.create({ model: 'folax/chatgpt', stream: true, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 429 });
    await expect(openai.chat.completions.create({ model: 'folax/unknown', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 400, code: 'model_not_found' });
  });
});

describe('Anthropic-compatible messages', () => {
  it('answers with the folax/ model id', async () => {
    folax.state.chatReply = 'Halo dari Grok.';
    const r = await anthropic.messages.create({ model: 'folax/grok', max_tokens: 100, messages: [{ role: 'user', content: 'hai' }] });
    expect(r.model).toBe('folax/grok');
    expect(r.content[0]).toMatchObject({ type: 'text', text: 'Halo dari Grok.' });
  });
});

describe('internal one-shot turns', () => {
  it('the prompt enhancer never runs on a Folax model', async () => {
    const r = await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'kucing', model: 'folax/chatgpt' } }));
    expect(r.status).toBeLessThan(500);
    expect(chats()).toHaveLength(0);
  });
});

// last: leaves the harness's Folax client marked down for its cache window
describe('Folax down', () => {
  it('a rejected token fails the turn; later Folax messages are refused before they are stored', async () => {
    const conv = await createConv({ model: 'folax/chatgpt' });
    // the adapter reports a rejected token inside the stream (it shows up after the request was accepted)
    folax.state.chatMidError = 'auth_invalid';
    const r = await send(conv.body.id, { text: 'halo' });
    expect(r.body.message).toMatchObject({ stop_reason: 'error', error: { code: 'provider_unavailable' } });
    const again = await send(conv.body.id, { text: 'halo lagi' });
    expect(again).toMatchObject({ status: 503, body: { error: { code: 'provider_unavailable' } } });
    expect(chats()).toHaveLength(1);
    // Qoder chats are unaffected
    const q = await createConv({});
    expect((await send(q.body.id, { text: 'halo qoder' })).body.message.stop_reason).toBe('end_turn');
  });
});

describe('server without Folax', () => {
  it('does not list Folax models and rejects them explicitly (no silent Qoder fallback)', async () => {
    const bare = await startHarness();
    try {
      const models = await json(await bare.api('/api/v1/models'));
      expect(models.body.data.some((m: any) => m.id.startsWith('folax/'))).toBe(false);
      const conv = await json(await bare.api('/api/v1/conversations', { method: 'POST', json: { model: 'folax/chatgpt' } }));
      expect(conv).toMatchObject({ status: 400, body: { error: { code: 'provider_unavailable' } } });
    } finally {
      await bare.close();
    }
  });
});
