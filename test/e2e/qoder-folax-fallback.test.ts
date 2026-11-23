import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folaxSafePrompt } from '../../src/core/folaxFallback.js';
import { ReferenceReader } from '../../src/core/references.js';
import type { TurnRunner } from '../../src/core/turns.js';
import { PromptVariator } from '../../src/core/variations.js';
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

const client = () => new FolaxClient({ baseUrl: folax.url, apiKey: folax.key, log: silentLogger });
const chats = () => folax.callsTo('POST /v1/chat/completions');
const stubTurns = (turns: Partial<TurnRunner>) => ({ interrupt: async () => true, ...turns }) as TurnRunner;
const qoderDown = stubTurns({ start: async () => { throw new Error('qoder down'); } });
const qoderReplies = (text: string) => stubTurns({ start: async () => ({ done: Promise.resolve({ stopReason: 'end_turn', text, model: 'qmodel', credits: { total: 3 } }) }) as any });
const reader = (turns: TurnRunner, o: { folax?: boolean; waitMs?: number } = {}) =>
  new ReferenceReader({ conversations: h.ctx.conversations, turns, store: h.ctx.store, log: silentLogger, folax: o.folax === false ? null : client(), qoderWaitMs: o.waitMs ?? 200 });

async function upload(color = '#3a6') {
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'ref.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

const TRAITS = { subject: 'woman in a green qipao', outfit: 'mint silk qipao', background: 'Chinese garden' };

describe('folaxSafePrompt', () => {
  it('drops only our rule lines; user data blocks and image descriptions stay', () => {
    const text = [
      'Rules:',
      '- If an idea asks for explicit sexual content or nudity, write a tasteful version.',
      '- Keep it short.',
      'Reference 1: {"palette":"nude and blush tones"}',
      '<hints>Preferred style: nude palette.</hints>',
      '<user-words>',
      '- busty model, nude heels',
      '</user-words>',
      '- If the prompt sexualises minors, return "a calm empty studio backdrop".',
      '<prompt>',
      '- nude lipstick close-up',
      '</prompt>',
    ].join('\n');
    expect(folaxSafePrompt(text).split('\n')).toEqual([
      'Rules:',
      '- Keep it short.',
      'Reference 1: {"palette":"nude and blush tones"}',
      '<hints>Preferred style: nude palette.</hints>',
      '<user-words>',
      '- busty model, nude heels',
      '</user-words>',
      '<prompt>',
      '- nude lipstick close-up',
      '</prompt>',
    ]);
  });
});

describe('image descriptions fall back to Folax vision', () => {
  it('reads the image with Folax when Qoder fails, and caches the traits', async () => {
    folax.state.chatReply = JSON.stringify(TRAITS);
    const f = await upload();
    const [d] = await reader(qoderDown).describeAll(await h.ctx.store.get(f.id, h.userId).then((x) => [x]), h.userId);
    expect(d!.traits).toMatchObject(TRAITS);
    expect(d!.credits).toBe(0);
    const body = chats()[0]!.body as any;
    expect(body.model).toBe('gemini');
    const parts = body.messages.at(-1).content;
    expect(parts.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
    expect(parts.find((p: any) => p.type === 'text').text).toContain('<describe-reference>');
    // cached: the next read asks nobody
    const again = await reader(qoderDown).describe(await h.ctx.store.get(f.id, h.userId), h.userId);
    expect(again).toMatchObject({ cached: true, traits: TRAITS });
    expect(chats()).toHaveLength(1);
  });

  it('also when Qoder is slow (interrupted) or replies with no JSON; a good Qoder read never asks Folax', async () => {
    folax.state.chatReply = JSON.stringify(TRAITS);
    let interrupted = false;
    const slow = stubTurns({ start: async () => ({ done: new Promise(() => {}) }) as any, interrupt: async () => ((interrupted = true), true) });
    expect((await reader(slow).describe(await h.ctx.store.get((await upload('#111')).id, h.userId), h.userId)).traits).toMatchObject(TRAITS);
    expect(interrupted).toBe(true);
    expect((await reader(qoderReplies('maaf')).describe(await h.ctx.store.get((await upload('#222')).id, h.userId), h.userId)).traits).toMatchObject(TRAITS);
    expect(chats()).toHaveLength(2);

    const good = await reader(qoderReplies('{"subject":"dari qoder"}')).describe(await h.ctx.store.get((await upload('#333')).id, h.userId), h.userId);
    expect(good).toMatchObject({ traits: { subject: 'dari qoder' }, credits: 3 });
    expect(chats()).toHaveLength(2);
  });

  it('retries once when the adapter queue is full; null traits when Folax fails or is not configured', async () => {
    folax.state.chatReply = JSON.stringify(TRAITS);
    folax.failNext('POST /v1/chat/completions', 429, 'queue_timeout');
    expect((await reader(qoderDown).describe(await h.ctx.store.get((await upload('#444')).id, h.userId), h.userId)).traits).toMatchObject(TRAITS);
    expect(chats()).toHaveLength(2);

    folax.reset();
    folax.state.chatReply = 'The current information may contain inappropriate content.';
    expect((await reader(qoderDown).describe(await h.ctx.store.get((await upload('#555')).id, h.userId), h.userId)).traits).toBeNull();
    expect((await reader(qoderDown, { folax: false }).describe(await h.ctx.store.get((await upload('#666')).id, h.userId), h.userId)).traits).toBeNull();
  });

  it('head swap describe falls back too', async () => {
    folax.state.chatReply = '{"hair":"black low bun","expression":"soft smile","angle":"slight tilt"}';
    const f = await upload('#777');
    const d = await reader(qoderDown).describeHead(f.id, h.userId, { prompt: 'Describe hair, expression, angle as JSON' });
    expect(d).toMatchObject({ traits: { hair: 'black low bun', expression: 'soft smile', angle: 'slight tilt' }, cached: false, credits: 0 });
    expect((await reader(qoderDown).describeHead(f.id, h.userId, { prompt: 'x' })).cached).toBe(true);
  });
});

describe('prompt variations fall back to Folax', () => {
  const variator = (turns: TurnRunner, o: { folax?: boolean } = {}) =>
    new PromptVariator({
      conversations: h.ctx.conversations,
      turns,
      references: reader(turns, o),
      log: silentLogger,
      folax: o.folax === false ? null : client(),
      qoderWaitMs: 200,
    });
  const reply = (n: number) => JSON.stringify({ variations: Array.from({ length: n }, (_, i) => ({ prompt: `variant ${i + 1} in a sunny park`, changed: { background: `park ${i + 1}` } })) });

  it('writes them with folax/gemini when Qoder fails; references are read by Folax first', async () => {
    const ref = await upload('#888');
    // the vision call (it carries the image) answers with traits, the variation call with variations
    folax.state.chatReplyFn = (body) => (JSON.stringify(body.messages).includes('image_url') ? JSON.stringify(TRAITS) : reply(3));
    const r = await variator(qoderDown).vary({ userId: h.userId, prompt: 'a woman in a qipao in a garden', n: 3, referenceFileIds: [ref.id] });
    expect(r).toMatchObject({ model: 'folax/gemini', credits: 0 });
    expect(r.variations.map((x) => x.prompt)).toEqual(['variant 1 in a sunny park', 'variant 2 in a sunny park', 'variant 3 in a sunny park']);
    const text = JSON.stringify(chats()[1]!.body);
    expect(text).toContain('woman in a green qipao'); // Folax's read of the reference reached the variation prompt
    expect(text).not.toMatch(/sexualises minors/);
  });

  it('chatgpt after a gemini failure; 502 variation_failed when everything fails', async () => {
    folax.state.chatReplies = { gemini: 'no json here', chatgpt: reply(2) };
    expect((await variator(qoderDown).vary({ userId: h.userId, prompt: 'a cat', n: 2 })).model).toBe('folax/chatgpt');
    folax.reset();
    await expect(variator(qoderDown, { folax: false }).vary({ userId: h.userId, prompt: 'a cat', n: 2 })).rejects.toMatchObject({ code: 'variation_failed' });
  });

  it('a good Qoder reply never asks Folax', async () => {
    const r = await variator(qoderReplies(reply(2))).vary({ userId: h.userId, prompt: 'a cat', n: 2 });
    expect(r.model).toBe('qmodel');
    expect(chats()).toHaveLength(0);
  });
});
