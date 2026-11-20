import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snippetAround } from '../../src/core/conversations.js';
import { type Harness, startHarness } from './harness.js';

/** GET /conversations/search: title + message text, the user's visible conversations only. */

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { AUTO_TITLE: 'false' } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const create = async (title?: string, key?: string) =>
  (await json(await h.api('/api/v1/conversations', { method: 'POST', json: { profile: 'chat', ...(title ? { title } : {}) }, key }))).body;
const say = (id: string, text: string, key?: string) => h.api(`/api/v1/conversations/${id}/messages`, { method: 'POST', json: { text }, key });
const search = async (q: string, key?: string, extra = '') => json(await h.api(`/api/v1/conversations/search?q=${encodeURIComponent(q)}${extra}`, { key }));

describe('GET /conversations/search', () => {
  it('finds titles and message text, newest first, with a snippet around the match', async () => {
    const byTitle = await create('Kabar terbaru Jensen Huang');
    const byMessage = await create('Saham teknologi');
    await say(byMessage.id, 'Bagaimana prospek saham Nvidia setelah CEO Jensen Huang mundur? Tolong bahas juga dampaknya ke pasar Asia.');
    const other = await create('Resep nasi goreng');
    await say(other.id, 'pakai terasi atau tidak?');

    const r = await search('jensen');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.conversation.id)).toEqual([byMessage.id, byTitle.id]); // byMessage was updated last
    const [msgHit, titleHit] = r.body.data;
    expect(msgHit).toMatchObject({ match: 'message', message_id: expect.stringMatching(/^msg_/) });
    expect(msgHit.snippet).toContain('Jensen Huang');
    expect(titleHit).toMatchObject({ match: 'title', snippet: null, message_id: null, conversation: { title: 'Kabar terbaru Jensen Huang' } });
  });

  it("never shows archived, hidden or another user's conversations; LIKE wildcards are literal", async () => {
    const archived = await create('Rahasia zebra');
    await h.api(`/api/v1/conversations/${archived.id}`, { method: 'DELETE' });
    const theirs = await create('Zebra punya admin', h.admin.apiKey);
    // a hidden helper conversation (the titler's) holds the same words
    await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'titler', title: 'zebra helper', metadata: { hidden: true } });
    expect((await search('zebra')).body.data).toEqual([]);
    expect((await search('zebra', h.admin.apiKey)).body.data.map((x: any) => x.conversation.id)).toEqual([theirs.id]);

    await create('Diskon 100% hari ini');
    await create('Diskon 1000 hari ini');
    expect((await search('100%')).body.data.map((x: any) => x.conversation.title)).toEqual(['Diskon 100% hari ini']);
    expect((await search('_')).status).toBe(400); // too short
  });

  it('only searches text blocks, not file ids or JSON keys', async () => {
    const conv = await create('Catatan');
    await say(conv.id, 'halo');
    expect((await search('"type"')).body.data).toEqual([]);
    expect((await search('text')).body.data.every((x: any) => x.conversation.id !== conv.id)).toBe(true);
  });

  it('validates q and caps limit', async () => {
    expect((await search('a')).status).toBe(400);
    expect((await search('x'.repeat(201))).status).toBe(400);
    for (let i = 0; i < 3; i++) await create(`Limit test ${i}`);
    expect((await search('limit test', undefined, '&limit=2')).body.data).toHaveLength(2);
  });
});

describe('snippetAround', () => {
  it('cuts around the match on word edges with ellipses', () => {
    const text = `${'kata '.repeat(60)}Jensen Huang mundur dari Nvidia ${'lagi '.repeat(60)}`;
    const s = snippetAround(text, 'jensen');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('Jensen Huang');
    expect(s.length).toBeLessThanOrEqual(122);
    expect(snippetAround('pendek\n\nsaja', 'saja')).toBe('pendek saja');
  });
});
