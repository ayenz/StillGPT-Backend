import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUCTIONS } from '../../src/core/enhancer.js';
import { EnhancerInstructions } from '../../src/core/enhancerInstructions.js';
import { kv } from '../../src/db/schema.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin/enhancer${path}`, { ...init, key: h.admin.apiKey });
const CUSTOM = 'You are a minimalist prompt writer. Always use a pastel palette and soft daylight. Keep it under 40 words.';

/** Captures the text the enhancer sends to the LLM. */
function capture() {
  const seen: string[] = [];
  h.qoder.setReply((text) => {
    if (!text.includes('<idea>')) return undefined;
    seen.push(text);
    return '{"prompt":"pastel cat","aspect_ratio":"4:5"}';
  });
  return seen;
}

describe('admin enhancer instructions', () => {
  it('is admin-only', async () => {
    expect((await h.api('/api/v1/admin/enhancer/instructions')).status).toBe(403);
    expect((await h.api('/api/v1/admin/enhancer/test', { method: 'POST', json: { prompt: 'x' } })).status).toBe(403);
  });

  it('lists the defaults and the fixed contract', async () => {
    const r = await json(await admin('/instructions'));
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.kind)).toEqual(['image', 'video']);
    const image = r.body.data[0];
    expect(image).toMatchObject({ source: 'default', updated_at: null, instructions: DEFAULT_INSTRUCTIONS.image, default: DEFAULT_INSTRUCTIONS.image });
    expect(image.contract).toContain('Reply with ONLY a JSON object');
    expect(r.body.data[1].contract).toContain('"seconds"');
  });

  it('saves, applies on the next enhance, keeps the contract, and resets', async () => {
    const put = await json(await admin('/instructions/image', { method: 'PUT', json: { instructions: `  ${CUSTOM}  ` } }));
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ kind: 'image', source: 'admin', instructions: CUSTOM });
    expect(put.body.updated_at).toBeTruthy();

    const seen = capture();
    const r = await json(await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'kucing', purpose: 'poster' } }));
    expect(r.body).toMatchObject({ enhanced: true, aspect_ratio: '4:5', size: '1024x1280' });
    expect(seen[0]).toContain(CUSTOM);
    expect(seen[0]).not.toContain('expert prompt engineer');
    expect(seen[0]).toContain('Purpose: poster.');
    expect(seen[0]).toContain('Reply with ONLY a JSON object');
    expect(seen[0]).toMatch(/<idea>\nkucing\n<\/idea>$/);

    // video still uses its default
    const seenV = capture();
    await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'ombak', kind: 'video' } });
    expect(seenV[0]).toContain(DEFAULT_INSTRUCTIONS.video);

    // persisted: a fresh store reads it back
    const fresh = new EnhancerInstructions({ db: h.ctx.database.db, log: h.ctx.log });
    await fresh.load();
    expect(fresh.get('image')).toBe(CUSTOM);

    const del = await json(await admin('/instructions/image', { method: 'DELETE' }));
    expect(del.body).toMatchObject({ source: 'default', instructions: DEFAULT_INSTRUCTIONS.image, updated_at: null });
    expect(await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'enhancer.instructions.image'))).toHaveLength(0);
  });

  it('validates', async () => {
    expect((await admin('/instructions/audio')).status).toBe(400);
    expect((await admin('/instructions/image', { method: 'PUT', json: { instructions: 'short' } })).status).toBe(400);
    expect((await admin('/instructions/image', { method: 'PUT', json: { instructions: 'x'.repeat(8001) } })).status).toBe(400);
    expect((await admin('/instructions/image', { method: 'PUT', json: {} })).status).toBe(400);
    expect((await json(await admin('/instructions/image'))).body.source).toBe('default');
  });

  it('tests a draft without saving it', async () => {
    const seen = capture();
    const r = await json(await admin('/test', { method: 'POST', json: { prompt: 'kucing', instructions: CUSTOM } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enhanced: true, prompt: 'pastel cat', instructions_source: 'draft' });
    expect(seen[0]).toContain(CUSTOM);
    expect((await json(await admin('/instructions/image'))).body.source).toBe('default');

    const saved = await json(await admin('/test', { method: 'POST', json: { prompt: 'kucing' } }));
    expect(saved.body.instructions_source).toBe('default');
    expect((await admin('/test', { method: 'POST', json: { prompt: 'kucing', instructions: 'x' } })).status).toBe(400);
  });

  it('end users cannot pass instructions through /prompts/enhance', async () => {
    const seen = capture();
    await h.api('/api/v1/prompts/enhance', { method: 'POST', json: { prompt: 'kucing', instructions: CUSTOM, instructionsOverride: CUSTOM } });
    expect(seen[0]).not.toContain(CUSTOM);
  });
});
