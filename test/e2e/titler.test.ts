import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConversationTitler, cleanTitle, titleSource } from '../../src/core/titler.js';
import type { TurnRunner } from '../../src/core/turns.js';
import { silentLogger } from '../../src/log.js';
import { FolaxClient } from '../../src/providers/folax.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => (await res.json()) as any;
const isTitlePrompt = (t: string) => t.startsWith('Write a short title');

async function newConversation(extra: Record<string, unknown> = {}) {
  return json(await h.api('/api/v1/conversations', { method: 'POST', json: { profile: 'chat', ...extra } }));
}
const send = (id: string, text: string, stream = false) =>
  h.api(`/api/v1/conversations/${id}/messages`, { method: 'POST', json: { text }, ...(stream ? { headers: { accept: 'text/event-stream' } } : {}) });
const titleOf = async (id: string) => (await json(await h.api(`/api/v1/conversations/${id}`))).title as string | null;

describe('cleanTitle / titleSource', () => {
  it('cleans LLM replies into one plain line', () => {
    expect(cleanTitle('Resep Nasi Goreng Kampung')).toBe('Resep Nasi Goreng Kampung');
    expect(cleanTitle('"Debug Error CORS di Express".')).toBe('Debug Error CORS di Express');
    expect(cleanTitle('Title: **Ide Caption Kopi**\n\nAlasan: ...')).toBe('Ide Caption Kopi');
    expect(cleanTitle('# Judul: Liburan ke Bali')).toBe('Liburan ke Bali');
    expect(cleanTitle('   \n  ')).toBeNull();
    expect(cleanTitle('x'.repeat(200))!.length).toBe(80);
  });

  it('builds the source from text and attachment hints', () => {
    expect(titleSource([{ type: 'text', text: 'ringkas dokumen ini' }, { type: 'document', fileId: 'f', filename: 'laporan.pdf', mimeType: 'application/pdf' }])).toBe(
      'ringkas dokumen ini\n[document: laporan.pdf]',
    );
    expect(titleSource([{ type: 'image', fileId: 'f', mimeType: 'image/png' }])).toBe('[image]');
    expect(titleSource([])).toBeNull();
  });
});

describe('auto conversation titles', () => {
  it('names a new chat from its first message with the titler model, once', async () => {
    let titlerModel = '';
    let seen = '';
    h.qoder.setReply((t, model) => {
      if (!isTitlePrompt(t)) return undefined;
      titlerModel = model;
      seen = t;
      return 'Resep Nasi Goreng';
    });
    const conv = await newConversation();
    const r = await json(await send(conv.id, 'gimana cara bikin nasi goreng kampung yang enak?'));
    expect(r.conversation.title).toBe('Resep Nasi Goreng'); // non-streaming response already carries it
    expect(titlerModel).toBe('dfmodel'); // `titler` alias, fastest model first
    expect(seen).toContain('gimana cara bikin nasi goreng kampung yang enak?');

    // later messages never re-title
    h.qoder.setReply((t) => (isTitlePrompt(t) ? 'Judul Lain' : undefined));
    await json(await send(conv.id, 'kalau pakai terasi gimana?'));
    expect(await titleOf(conv.id)).toBe('Resep Nasi Goreng');

    // the titler's helper conversations stay hidden from the list
    const list = await json(await h.api('/api/v1/conversations?limit=100'));
    expect(list.data.some((c: any) => /titler/.test(c.title ?? ''))).toBe(false);
  });

  it('does not touch chats created with a title', async () => {
    let called = false;
    h.qoder.setReply((t) => (isTitlePrompt(t) ? ((called = true), 'X') : undefined));
    const conv = await newConversation({ title: 'Punya Gw' });
    await json(await send(conv.id, 'halo'));
    expect(called).toBe(false);
    expect(await titleOf(conv.id)).toBe('Punya Gw');
  });

  it('a manual rename wins over a late auto title', async () => {
    h.qoder.setReply((t) => (isTitlePrompt(t) ? 'Auto Title' : undefined));
    const conv = await newConversation();
    // the user renames while the titler is still running → its late result must be dropped
    await h.api(`/api/v1/conversations/${conv.id}`, { method: 'PATCH', json: { title: 'CV Lamaran' } });
    expect(await h.ctx.titler!.generate(conv.id, h.userId, [{ type: 'text', text: 'tolong bantu bikin CV' }])).toBeNull();
    expect(await titleOf(conv.id)).toBe('CV Lamaran');
    // without a rename the same call does set it
    const other = await newConversation();
    expect(await h.ctx.titler!.generate(other.id, h.userId, [{ type: 'text', text: 'tolong bantu bikin CV' }])).toBe('Auto Title');
    expect(await titleOf(other.id)).toBe('Auto Title');
  });

  it('falls back to the first message when the titler reply is unusable', async () => {
    h.qoder.setReply((t) => (isTitlePrompt(t) ? '   ' : undefined));
    const conv = await newConversation();
    const frames = await readSse(await send(conv.id, 'jelaskan   teori relativitas', true));
    expect(frames.some((f) => f.event === 'conversation.title')).toBe(false);
    expect(frames.at(-1)!.event).toBe('turn.completed');
    expect(await titleOf(conv.id)).toBe('jelaskan teori relativitas');
  });

  it('can be switched off with AUTO_TITLE=false', async () => {
    const h2 = await startHarness({ env: { AUTO_TITLE: 'false' } });
    try {
      expect(h2.ctx.titler).toBeNull();
      const conv = await json(await h2.api('/api/v1/conversations', { method: 'POST', json: { profile: 'chat' } }));
      await h2.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'halo dunia' } });
      expect((await json(await h2.api(`/api/v1/conversations/${conv.id}`))).title).toBe('halo dunia');
    } finally {
      await h2.close();
    }
  });
});

describe('title and reply run side by side', () => {
  it('sends the title mid-reply, as soon as it exists', async () => {
    const original = h.ctx.titler!.generate.bind(h.ctx.titler!);
    h.ctx.titler!.generate = async () => 'Judul Cepat';
    try {
      const conv = await newConversation();
      // [[slow]]: the mock answers after ~1 s, the title is ready at once
      const frames = await readSse(await send(conv.id, '[[slow]] ceritain sejarah kopi', true));
      const events = frames.map((f) => f.event);
      const titleAt = events.indexOf('conversation.title');
      expect(titleAt).toBeGreaterThan(-1);
      expect(titleAt).toBeLessThan(events.indexOf('text.completed'));
      expect(frames[titleAt]!.data).toMatchObject({ title: 'Judul Cepat' });
    } finally {
      h.ctx.titler!.generate = original;
    }
  });

  it('the reply never waits for a slow title', async () => {
    const original = h.ctx.titler!.generate.bind(h.ctx.titler!);
    let release!: (t: string | null) => void;
    h.ctx.titler!.generate = () => new Promise((r) => (release = r));
    try {
      const conv = await newConversation();
      const started = Date.now();
      const frames = await readSse(await send(conv.id, 'halo', true));
      expect(Date.now() - started).toBeLessThan(2000); // used to hold turn.completed for up to AUTO_TITLE_WAIT_MS (5 s)
      expect(frames.at(-1)!.event).toBe('turn.completed');
      expect(frames.some((f) => f.event === 'conversation.title')).toBe(false);
    } finally {
      release(null);
      h.ctx.titler!.generate = original;
    }
  });
});

describe('Folax fallback for titles', () => {
  let folax: FakeFolax;
  beforeAll(async () => {
    folax = await startFakeFolax();
  });
  afterEach(() => folax.reset());
  afterAll(() => folax?.close());

  /** A titler whose Qoder turn is `turns` (a stub) and whose Folax is the fake adapter. */
  const titler = (turns: Partial<TurnRunner>, o: { folax?: boolean; waitMs?: number } = {}) =>
    new ConversationTitler({
      db: h.ctx.database.db,
      conversations: h.ctx.conversations,
      turns: { interrupt: async () => true, ...turns } as TurnRunner,
      log: silentLogger,
      model: 'titler',
      folax: o.folax === false ? null : new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger }),
      qoderWaitMs: o.waitMs ?? 200,
    });
  const chats = () => folax.callsTo('POST /v1/chat/completions');
  const content = [{ type: 'text' as const, text: 'gimana cara bikin nasi goreng kampung?' }];

  it('names the chat with folax/gemini when the Qoder turn fails', async () => {
    folax.state.chatReply = '"Resep nasi goreng kampung"';
    const conv = await newConversation();
    const t = titler({ start: async () => { throw new Error('qoder down'); } });
    expect(await t.generate(conv.id, h.userId, content)).toBe('Resep nasi goreng kampung');
    expect(await titleOf(conv.id)).toBe('Resep nasi goreng kampung');
    expect(chats()[0]!.body).toMatchObject({ model: 'gemini' });
    expect(JSON.stringify(chats()[0]!.body)).toContain('nasi goreng kampung');
  });

  it('and when Qoder answers with an error or takes too long (the slow turn is interrupted)', async () => {
    folax.state.chatReply = 'Judul dari Folax';
    const errored = titler({ start: async () => ({ done: Promise.resolve({ stopReason: 'error', text: '' }) }) as any });
    expect(await errored.generate((await newConversation()).id, h.userId, content)).toBe('Judul dari Folax');

    let interrupted = false;
    const slow = titler({ start: async () => ({ done: new Promise(() => {}) }) as any, interrupt: async () => ((interrupted = true), true) });
    expect(await slow.generate((await newConversation()).id, h.userId, content)).toBe('Judul dari Folax');
    expect(interrupted).toBe(true);
  });

  it('a good Qoder title never asks Folax', async () => {
    const t = titler({ start: async () => ({ done: Promise.resolve({ stopReason: 'end_turn', text: 'Judul Qoder' }) }) as any });
    expect(await t.generate((await newConversation()).id, h.userId, content)).toBe('Judul Qoder');
    expect(chats()).toHaveLength(0);
  });

  it('no title (and no throw) when both fail or Folax is not configured', async () => {
    const failing = { start: async () => { throw new Error('qoder down'); } };
    folax.failNext('POST /v1/chat/completions', 502, 'upstream_error');
    expect(await titler(failing).generate((await newConversation()).id, h.userId, content)).toBeNull();
    expect(await titler(failing, { folax: false }).generate((await newConversation()).id, h.userId, content)).toBeNull();
  });
});
