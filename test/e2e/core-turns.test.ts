import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnEvent } from '../../src/core/events.js';
import { drain, type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

const text = (t: string) => [{ type: 'text' as const, text: t }];

async function turn(conversationId: string, t: string) {
  const handle = await h.ctx.turns.start({ conversationId, userId: h.userId, content: text(t) });
  const events = await drain(handle.iterate());
  return { events, result: await handle.done };
}

describe('TurnRunner against mock Qoder', () => {
  it('streams deltas, completes and persists, keeps context across turns', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
    const first = await turn(conv.id, 'halo');
    const types = first.events.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('text.delta');
    expect(types.at(-1)).toBe('turn.completed');
    expect(first.result.text).toBe('[auto] Echo #1: halo');
    const deltas = first.events.filter((e): e is Extract<TurnEvent, { type: 'text.delta' }> => e.type === 'text.delta').map((e) => e.text).join('');
    expect(deltas).toBe(first.result.text);

    const second = await turn(conv.id, 'lagi [[history]]');
    expect(second.result.text).toContain('Echo #2');
    expect(second.result.text).toContain('History: halo');

    const msgs = await h.ctx.conversations.messages(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const saved = await h.ctx.conversations.get(conv.id);
    expect(saved.status).toBe('idle');
    expect(saved.title).toBe('halo');
  });

  it('switches model mid-conversation via session patch', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'cheap' });
    expect((await turn(conv.id, 'a')).result.text).toBe('[efficient] Echo #1: a');
    await h.ctx.conversations.update(conv.id, h.userId, { model: 'fast' });
    expect((await turn(conv.id, 'b')).result.text).toBe('[fast] Echo #2: b');
  });

  it('falls back when the model is retired upstream (seamless model lifecycle)', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'qfmodel' });
    expect((await turn(conv.id, 'x')).result.text).toBe('[qfmodel] Echo #1: x');
    h.qoder.retireModel('qfmodel');
    const r = await turn(conv.id, 'y');
    expect(r.events.some((e) => e.type === 'model.fallback')).toBe(true);
    expect(r.result.stopReason).toBe('end_turn');
    expect(r.result.text).toMatch(/^\[auto\] Echo #\d: y$/);
    expect(h.ctx.models.isActive('qfmodel')).toBe(false);
  });

  it('reports per-turn credits (session usage is cumulative upstream)', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
    const a = await turn(conv.id, 'one');
    const b = await turn(conv.id, 'two');
    expect(a.result.credits.total).toBeCloseTo(0.01);
    expect(b.result.credits.total).toBeCloseTo(0.01);
  });

  it('downloads artifacts into our store with a signed URL', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'assistant', model: 'default' });
    const r = await turn(conv.id, 'gambar kucing [[image]] size=1792x1024');
    expect(r.result.artifacts).toHaveLength(1);
    const art = r.result.artifacts[0]!;
    expect(art.mimeType).toBe('image/png');
    const res = await fetch(art.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bad = await fetch(art.url.replace(/sig=[^&]+/, 'sig=nope'));
    expect(bad.status).toBe(403);
  });

  it('surfaces upstream session errors and releases the lock', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
    const r = await turn(conv.id, 'boom [[error]]');
    expect(r.result.stopReason).toBe('error');
    expect(r.events.some((e) => e.type === 'error')).toBe(true);
    expect((await h.ctx.conversations.get(conv.id)).status).toBe('idle');
  });

  it('rejects a second turn while one is running (409)', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
    const handle = await h.ctx.turns.start({ conversationId: conv.id, userId: h.userId, content: text('pelan [[slow]]') });
    await expect(h.ctx.turns.start({ conversationId: conv.id, userId: h.userId, content: text('x') })).rejects.toMatchObject({ code: 'conversation_busy' });
    await handle.done;
  });
});
