import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUCTIONS, buildEnhancerPrompt, folaxSafePrompt, PromptEnhancer } from '../../src/core/enhancer.js';
import type { TurnRunner } from '../../src/core/turns.js';
import { silentLogger } from '../../src/log.js';
import { FolaxClient } from '../../src/providers/folax.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
let folax: FakeFolax;
beforeAll(async () => {
  h = await startHarness();
  folax = await startFakeFolax();
});
afterEach(() => folax.reset());
afterAll(async () => {
  await folax?.close();
  await h?.close();
});

/** An enhancer whose Qoder turn is `turns` (a stub) and whose Folax is the fake adapter. */
const enhancer = (turns: Partial<TurnRunner>, o: { folax?: boolean; waitMs?: number } = {}) =>
  new PromptEnhancer({
    conversations: h.ctx.conversations,
    turns: { interrupt: async () => true, ...turns } as TurnRunner,
    log: silentLogger,
    folax: o.folax === false ? null : new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger }),
    qoderWaitMs: o.waitMs ?? 200,
  });
const chats = () => folax.callsTo('POST /v1/chat/completions');
const qoderDown = { start: async () => { throw new Error('qoder down'); } };
const GOOD = '{"prompt":"A fluffy ginger cat asleep on a silver laptop, soft window light","aspect_ratio":"9:16"}';
const FILTERED = 'The current information may contain inappropriate content. We encourage all users to remain polite and respectful.';

describe('folaxSafePrompt', () => {
  it('drops only our rule lines with words Folax rejects; hints and the idea stay as typed', () => {
    const text = buildEnhancerPrompt({ kind: 'image', instructions: DEFAULT_INSTRUCTIONS.image, idea: 'model baju renang, tulisan "SALE"', purpose: 'nude palette poster' });
    const safe = folaxSafePrompt(text);
    expect(text).toMatch(/busty/);
    expect(safe).not.toMatch(/busty|sexual|nudity|sexualises minors/);
    expect(safe).toContain('<hints>Purpose: nude palette poster.</hints>');
    expect(safe.endsWith('<idea>\nmodel baju renang, tulisan "SALE"\n</idea>')).toBe(true);
    // the rest of the contract survives
    expect(safe).toContain('Reply with ONLY a JSON object');
    expect(safe).toContain('If the idea asks for one explicitly');
  });
});

describe('Folax fallback for the prompt enhancer', () => {
  it('writes the prompt with folax/gemini when the Qoder turn fails', async () => {
    folax.state.chatReply = GOOD;
    const r = await enhancer(qoderDown).enhance({ userId: h.userId, prompt: 'kucing oren tidur di atas laptop, wallpaper hp' });
    expect(r).toMatchObject({ enhanced: true, model: 'folax/gemini', credits: 0, aspect_ratio: '9:16', size: '1024x1792' });
    expect(r.prompt).toMatch(/ginger cat/);
    expect(chats()).toHaveLength(1);
    const sent = JSON.stringify(chats()[0]!.body);
    expect(chats()[0]!.body).toMatchObject({ model: 'gemini' });
    expect(sent).toContain('kucing oren tidur di atas laptop');
    expect(sent).not.toMatch(/busty|nudity/);
  });

  it('and when Qoder errors, replies with no JSON, or is too slow (the slow turn is interrupted)', async () => {
    folax.state.chatReply = GOOD;
    const errored = enhancer({ start: async () => ({ done: Promise.resolve({ stopReason: 'error', text: '', model: 'x', credits: { total: 0 } }) }) as any });
    expect((await errored.enhance({ userId: h.userId, prompt: 'kucing' })).model).toBe('folax/gemini');
    const chatter = enhancer({ start: async () => ({ done: Promise.resolve({ stopReason: 'end_turn', text: 'Maaf, credit habis', model: 'x', credits: { total: 0 } }) }) as any });
    expect((await chatter.enhance({ userId: h.userId, prompt: 'kucing' })).model).toBe('folax/gemini');

    let interrupted = false;
    const slow = enhancer({ start: async () => ({ done: new Promise(() => {}) }) as any, interrupt: async () => ((interrupted = true), true) });
    expect((await slow.enhance({ userId: h.userId, prompt: 'kucing' })).enhanced).toBe(true);
    expect(interrupted).toBe(true);
  });

  it('tries folax/chatgpt when gemini fails or answers without JSON', async () => {
    folax.state.chatReplies = { gemini: 'Here is a nice prompt about a cat!', chatgpt: GOOD };
    const r = await enhancer(qoderDown).enhance({ userId: h.userId, prompt: 'kucing' });
    expect(r).toMatchObject({ enhanced: true, model: 'folax/chatgpt' });
    expect(chats().map((c) => (c.body as any).model)).toEqual(['gemini', 'chatgpt']);

    folax.reset();
    folax.state.chatReply = GOOD;
    folax.failNext('POST /v1/chat/completions', 502, 'upstream_error');
    expect((await enhancer(qoderDown).enhance({ userId: h.userId, prompt: 'kucing' })).model).toBe('folax/chatgpt');
  });

  it("stops after Folax's content filter (the user's idea tripped it) and keeps the original prompt", async () => {
    folax.state.chatReply = FILTERED;
    const r = await enhancer(qoderDown).enhance({ userId: h.userId, prompt: 'ide yang kena filter' });
    expect(r).toMatchObject({ enhanced: false, prompt: 'ide yang kena filter' });
    expect(chats()).toHaveLength(1);
  });

  it('a good Qoder reply never asks Folax; no Folax configured → original prompt', async () => {
    const good = enhancer({ start: async () => ({ done: Promise.resolve({ stopReason: 'end_turn', text: GOOD, model: 'kmodel_latest', credits: { total: 2 } }) }) as any });
    expect((await good.enhance({ userId: h.userId, prompt: 'kucing' })).model).toBe('kmodel_latest');
    expect(chats()).toHaveLength(0);
    const r = await enhancer(qoderDown, { folax: false }).enhance({ userId: h.userId, prompt: 'kucing' });
    expect(r).toMatchObject({ enhanced: false, prompt: 'kucing' });
  });

  it('video: Folax suggestion for ratio and seconds is used', async () => {
    folax.state.chatReply = '{"prompt":"Drone glides over Bali rice terraces at sunrise","aspect_ratio":"9:16","seconds":8}';
    const r = await enhancer(qoderDown).enhance({ userId: h.userId, prompt: 'drone sawah bali, reels', kind: 'video' });
    expect(r).toMatchObject({ enhanced: true, model: 'folax/gemini', ratio: '9:16', seconds: 8 });
  });
});
