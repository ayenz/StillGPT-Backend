/**
 * Live smoke test against the real Qoder Cloud Agents API (costs a few credits; uses the `cheap` alias = efficient, price factor 0).
 *   QODER_PAT=pt-… npm run test:live
 *   QODER_LIVE_MEDIA=1 also generates one image (~30 s); QODER_LIVE_VIDEO=1 one 2-second video (~3 min).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { type AppContext, createContext } from '../../src/context.js';
import { createLogger } from '../../src/log.js';

const PAT = process.env.QODER_PAT;
const live = describe.skipIf(!PAT);

let ctx: AppContext;
let url: string;
let apiKey: string;
let close: () => Promise<void>;

beforeAll(async () => {
  if (!PAT) return;
  const mediaDir = await mkdtemp(join(tmpdir(), 'qr-live-'));
  const config = loadConfig({
    DATABASE_URL: 'pglite://memory',
    QODER_PAT: PAT,
    JWT_SECRET: 'live-test-secret-live-test-secret-123456',
    MEDIA_DIR: mediaDir,
    MODEL_SYNC_INTERVAL_MIN: '0',
    LOG_LEVEL: 'warn',
  });
  ctx = await createContext(config, { log: createLogger('warn') });
  const server = serve({ fetch: createApp(ctx).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (ctx.store as unknown as { publicBaseUrl: string }).publicBaseUrl = url;
  await ctx.start();
  const user = await ctx.auth.createUser({ email: 'live@test.local' });
  apiKey = (await ctx.auth.createApiKey(user.id, 'live')).key;
  close = async () => {
    server.close();
    await ctx.close();
    await rm(mediaDir, { recursive: true, force: true });
  };
});
afterAll(() => close?.());

live('StillGPT ↔ real Qoder', () => {
  it('syncs the model catalogue', () => {
    expect(ctx.models.listActive().length).toBeGreaterThan(3);
    expect(ctx.models.resolve('cheap').model).toBeTruthy();
  });

  it('OpenAI SDK: multi-turn chat keeps context on the same session', async () => {
    const client = new OpenAI({ baseURL: `${url}/v1`, apiKey });
    const history: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Nama saya Budi. Balas cukup "oke".' }];
    const first = await client.chat.completions.create({ model: 'cheap', messages: history });
    history.push({ role: 'assistant', content: first.choices[0]!.message.content ?? '' }, { role: 'user', content: 'Siapa nama saya? Jawab satu kata.' });
    const { data: second, response } = await client.chat.completions.create({ model: 'cheap', messages: history }).withResponse();
    expect(second.choices[0]!.message.content?.toLowerCase()).toContain('budi');
    expect(response.headers.get('x-stillgpt-conversation')).toBeTruthy();
  });

  it('OpenAI SDK: streaming yields deltas', async () => {
    const client = new OpenAI({ baseURL: `${url}/v1`, apiKey });
    const stream = await client.chat.completions.create({ model: 'cheap', stream: true, messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }] });
    let text = '';
    let chunks = 0;
    for await (const c of stream) {
      text += c.choices[0]?.delta?.content ?? '';
      chunks++;
    }
    expect(chunks).toBeGreaterThan(2);
    expect(text).toMatch(/1.*2.*3.*4.*5/s);
  });

  it('Anthropic SDK: messages', async () => {
    const client = new Anthropic({ baseURL: url, apiKey });
    const msg = await client.messages.create({ model: 'cheap', max_tokens: 100, system: 'Reply in uppercase only.', messages: [{ role: 'user', content: 'say hello' }] });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toMatch(/HELLO/);
  });

  it.skipIf(!process.env.QODER_LIVE_MEDIA)('image generation (OpenAI images API)', async () => {
    const client = new OpenAI({ baseURL: `${url}/v1`, apiKey });
    const img = await client.images.generate({ model: 'qoder-image', prompt: 'a red apple on a white table, studio photo', size: '1024x1024' });
    const res = await fetch(img.data![0]!.url!);
    expect(res.headers.get('content-type')).toMatch(/^image\//);
  });

  it.skipIf(!process.env.QODER_LIVE_VIDEO)('video generation job', async () => {
    const created = await (await fetch(`${url}/v1/videos`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'waves on a beach at sunset', seconds: 2, size: '1280x720' }) })).json();
    let job = created;
    for (let i = 0; i < 120 && !['completed', 'failed'].includes(job.status); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      job = await (await fetch(`${url}/v1/videos/${created.id}`, { headers: { authorization: `Bearer ${apiKey}` } })).json();
    }
    expect(job.status).toBe('completed');
  });
});
